-- The nightly retention job, in one transaction: it adds the monthly totals for every complete month that has none, then
-- deletes the raw records older than 13 months. If the totals fail, the transaction rolls back and nothing is deleted,
-- so no month is deleted without its totals. Safe to run again. Run it with psql -1 (nightly.sh retain).
--
-- nse_monthly is ours, not Umami's. Umami's migrations leave a table they do not know alone. It holds no session or
-- visit code: only counts, sums and percentiles, one dimension at a time (the one cross is version by device class, for
-- the timings). The rows are kept for good, and the delete below never touches them.
--   month     the first day of the month, UTC
--   metric    month     one row per website and month, name and value empty: n is the month's events. It marks the month as done
--             visits    pageviews, by name (all, version, browser, os, device, country, language) and value
--             sessions  the sessions with an event, by the same names and values
--             events    events by event name ('pageview' for a pageview)
--             value     events by "event.property" and value, for the properties that are text or flags
--             number    events that carry "event.property", with its total in `total`, for the numbers that are counts
--             time      "event.property" for the millisecond timings, by version and device class ('' for all)
--   n         the count; total, p50, p90 and p99 are set on number and time rows only
-- Umami v3.4.1 tables: event_data, website_event, session_data, session_link, session_replay, session_replay_saved,
-- revenue, session. It has no foreign keys (Prisma relationMode "prisma"); the order below is the one its code uses.
SET LOCAL TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS nse_monthly (
    month date NOT NULL,
    website_id uuid NOT NULL,
    metric text NOT NULL,
    name text NOT NULL,
    value text NOT NULL DEFAULT '',
    version text NOT NULL DEFAULT '',
    device text NOT NULL DEFAULT '',
    n bigint NOT NULL,
    total numeric,
    p50 numeric,
    p90 numeric,
    p99 numeric,
    PRIMARY KEY (month, website_id, metric, name, value, version, device)
);

-- A month is complete two days after it ends, so a visit that crosses midnight has been sent.
CREATE TEMP TABLE nse_todo ON COMMIT DROP AS
SELECT DISTINCT e.website_id, date_trunc('month', e.created_at)::date AS month
FROM website_event e
WHERE e.created_at < date_trunc('month', now() - interval '2 days')
  AND NOT EXISTS (
      SELECT 1 FROM nse_monthly m
      WHERE m.metric = 'month' AND m.website_id = e.website_id AND m.month = date_trunc('month', e.created_at)::date
  );

CREATE TEMP TABLE nse_ev ON COMMIT DROP AS
SELECT e.event_id, e.website_id, e.session_id, e.event_type,
       CASE WHEN e.event_type = 1 THEN 'pageview' ELSE coalesce(e.event_name, '') END AS name,
       t.month
FROM website_event e
JOIN nse_todo t ON t.website_id = e.website_id AND t.month = date_trunc('month', e.created_at)::date;

-- The version of the editor a session ran, from its visit event.
CREATE TEMP TABLE nse_version ON COMMIT DROP AS
SELECT ev.session_id, min(d.string_value) AS version
FROM nse_ev ev
JOIN event_data d ON d.website_event_id = ev.event_id
WHERE ev.name = 'visit' AND d.data_key = 'version'
GROUP BY ev.session_id;

CREATE TEMP TABLE nse_sess ON COMMIT DROP AS
SELECT ev.month, ev.website_id, ev.session_id,
       count(*) FILTER (WHERE ev.event_type = 1) AS visits,
       coalesce(v.version, 'unknown') AS version,
       coalesce(s.browser, 'unknown') AS browser,
       coalesce(s.os, 'unknown') AS os,
       coalesce(s.device, 'unknown') AS device,
       coalesce(s.country, 'unknown') AS country,
       coalesce(s.language, 'unknown') AS language
FROM nse_ev ev
LEFT JOIN session s ON s.session_id = ev.session_id
LEFT JOIN nse_version v ON v.session_id = ev.session_id
GROUP BY ev.month, ev.website_id, ev.session_id, v.version, s.browser, s.os, s.device, s.country, s.language;

-- A month keeps at most 5000 rows of a metric, the largest first, so junk sent to the public endpoint cannot grow the table.
-- The timings (ready, took, buildMs) are the catalogue's millisecond properties; a unit test checks the list.
INSERT INTO nse_monthly (month, website_id, metric, name, value, n)
SELECT month, website_id, metric, name, value, n
FROM (
    SELECT g.month, g.website_id, m.metric, g.name, g.value,
           CASE WHEN m.metric = 'visits' THEN sum(g.visits) ELSE count(*) END AS n,
           row_number() OVER (
               PARTITION BY g.month, g.website_id, m.metric
               ORDER BY CASE WHEN m.metric = 'visits' THEN sum(g.visits) ELSE count(*) END DESC, g.name, g.value
           ) AS rn
    FROM (
        SELECT s.month, s.website_id, s.visits, x.name, x.value
        FROM nse_sess s
        CROSS JOIN LATERAL (VALUES
            ('all', ''), ('version', s.version), ('browser', s.browser), ('os', s.os),
            ('device', s.device), ('country', s.country), ('language', s.language)
        ) x(name, value)
    ) g
    CROSS JOIN (VALUES ('visits'), ('sessions')) m(metric)
    GROUP BY g.month, g.website_id, m.metric, g.name, g.value
) t
WHERE rn <= 5000 AND n > 0;

INSERT INTO nse_monthly (month, website_id, metric, name, n)
SELECT month, website_id, metric, name, n
FROM (
    SELECT month, website_id, 'events' AS metric, name, count(*) AS n,
           row_number() OVER (PARTITION BY month, website_id ORDER BY count(*) DESC, name) AS rn
    FROM nse_ev
    GROUP BY month, website_id, name
) t
WHERE rn <= 5000;

INSERT INTO nse_monthly (month, website_id, metric, name, value, n)
SELECT month, website_id, 'value', name, value, n
FROM (
    SELECT ev.month, ev.website_id, ev.name || '.' || d.data_key AS name, coalesce(d.string_value, '') AS value, count(*) AS n,
           row_number() OVER (
               PARTITION BY ev.month, ev.website_id
               ORDER BY count(*) DESC, ev.name || '.' || d.data_key, coalesce(d.string_value, '')
           ) AS rn
    FROM nse_ev ev
    JOIN event_data d ON d.website_event_id = ev.event_id
    WHERE d.data_type IN (1, 3)
    GROUP BY ev.month, ev.website_id, ev.name, d.data_key, d.string_value
) t
WHERE rn <= 5000;

INSERT INTO nse_monthly (month, website_id, metric, name, n, total)
SELECT month, website_id, 'number', name, n, total
FROM (
    SELECT ev.month, ev.website_id, ev.name || '.' || d.data_key AS name, count(*) AS n, round(sum(d.number_value)) AS total,
           row_number() OVER (
               PARTITION BY ev.month, ev.website_id
               ORDER BY count(*) DESC, ev.name || '.' || d.data_key
           ) AS rn
    FROM nse_ev ev
    JOIN event_data d ON d.website_event_id = ev.event_id
    WHERE d.data_type = 2 AND d.data_key NOT IN ('ready', 'took', 'buildMs')
    GROUP BY ev.month, ev.website_id, ev.name, d.data_key
) t
WHERE rn <= 5000;

INSERT INTO nse_monthly (month, website_id, metric, name, version, device, n, p50, p90, p99)
SELECT month, website_id, 'time', name, version, device, n, p50, p90, p99
FROM (
    SELECT ev.month, ev.website_id, ev.name || '.' || d.data_key AS name, g.version, g.device, count(*) AS n,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.number_value::float8)) AS p50,
           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY d.number_value::float8)) AS p90,
           round(percentile_cont(0.99) WITHIN GROUP (ORDER BY d.number_value::float8)) AS p99,
           row_number() OVER (
               PARTITION BY ev.month, ev.website_id
               ORDER BY count(*) DESC, ev.name || '.' || d.data_key, g.version, g.device
           ) AS rn
    FROM nse_ev ev
    JOIN event_data d ON d.website_event_id = ev.event_id
    LEFT JOIN session s ON s.session_id = ev.session_id
    LEFT JOIN nse_version v ON v.session_id = ev.session_id
    CROSS JOIN LATERAL (VALUES
        ('', ''),
        (coalesce(v.version, 'unknown'), ''),
        ('', coalesce(s.device, 'unknown')),
        (coalesce(v.version, 'unknown'), coalesce(s.device, 'unknown'))
    ) g(version, device)
    WHERE d.data_type = 2 AND d.data_key IN ('ready', 'took', 'buildMs')
    GROUP BY ev.month, ev.website_id, ev.name, d.data_key, g.version, g.device
) t
WHERE rn <= 5000;

-- Last, so a month is marked done only with its rows.
INSERT INTO nse_monthly (month, website_id, metric, name, n)
SELECT month, website_id, 'month', '', count(*) FROM nse_ev GROUP BY month, website_id;

-- Every month before the cutoff has its totals now. Events and their data go first, then the sessions that have no event
-- left, with what hangs off them.
CREATE TEMP TABLE nse_cutoff ON COMMIT DROP AS SELECT now() - interval '13 months' AS earliest;

DELETE FROM event_data
WHERE created_at < (SELECT earliest FROM nse_cutoff)
   OR website_event_id IN (SELECT event_id FROM website_event WHERE created_at < (SELECT earliest FROM nse_cutoff));
DELETE FROM website_event WHERE created_at < (SELECT earliest FROM nse_cutoff);

CREATE TEMP TABLE nse_gone ON COMMIT DROP AS
SELECT s.session_id
FROM session s
WHERE s.created_at < (SELECT earliest FROM nse_cutoff)
  AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id);

DELETE FROM session_data WHERE session_id IN (SELECT session_id FROM nse_gone);
DELETE FROM session_link WHERE session_id IN (SELECT session_id FROM nse_gone);
DELETE FROM session_replay WHERE session_id IN (SELECT session_id FROM nse_gone) OR created_at < (SELECT earliest FROM nse_cutoff);
DELETE FROM session_replay_saved WHERE created_at < (SELECT earliest FROM nse_cutoff);
DELETE FROM revenue WHERE session_id IN (SELECT session_id FROM nse_gone) OR created_at < (SELECT earliest FROM nse_cutoff);
DELETE FROM session WHERE session_id IN (SELECT session_id FROM nse_gone);
