-- The nightly retention job, in one transaction, run by `nightly.sh retain` as `allowlist.sql` followed by this file
-- with psql -1. It totals the raw records of every complete month into nse_monthly, then deletes the raw records older
-- than 13 months. If the totals fail, the transaction rolls back and nothing is deleted. Safe to run again.
--
-- nse_monthly is ours, not Umami's; Umami's migrations leave a table they do not know alone. It is kept for good and the
-- delete below never touches it. It holds no session or visit code, and only what the catalogue allows:
--   * Only an event name, a property and a value in nse_allowed (generated from src/analytics/catalogue.ts) are totalled.
--     The public endpoint takes anything, so anything else, such as an email address sent by hand, is left out. A session
--     column that is not in Umami's lists is counted as "other".
--   * A row stands for at least 10 distinct sessions (`contributors`, as a stand-in for people). A cell with fewer is
--     merged into an "other" row of its metric when that has 10, and left out when it does not. A sum is kept only for
--     10 or more sessions. A timing is made only from the groups of version by device class that have 10 or more
--     sessions, for every row, so a left-out measurement is in no percentile.
--   * A name keeps at most 50 values a month (100 countries), the most common first, and the rest are "other". Only the
--     version, the language, the country and the browser language have more than that.
--   * A session has the editor version of its visit events only if they all agree; else "mixed". No version: "unknown".
-- Every night the totals of each complete month are made again from the raw records, so a late report is counted. A
-- month is made final, with a row of metric "final", in the run that first deletes one of its records; it is not made
-- again, because its records are partly gone.
--   month     the first day of the month, UTC
--   metric    visits    pageviews, by name (all, version, browser, os, device, country, language) and value
--             sessions  the sessions with an event, by the same names and values
--             events    events by event name ("pageview" for a pageview)
--             value     events by "event.property" and value, for the properties that are text or flags
--             number    "event.property" for the counts: events that carry it, and the sum of its values in `total`
--             time      "event.property" for the millisecond timings: p50, p90 and p99, overall and by version and
--                       device class ('' for all)
--             final     marks a month that is not totalled again
-- nse_weekly holds the headline counts by ISO week (UTC, Monday first): visits and sessions (name "all") and events by
-- event name, with the same allowlist and the same 10-session rule, made again every night until the week is final.
-- It has no breakdowns, no sums and no timings, only counts, so nothing in it can be subtracted from a monthly sum or
-- timing to recover a left-out value. It is a table of its own because its key is a week, not a month, and so the
-- monthly rows and queries stay as they are.
-- Umami v3.4.1 tables with visitor data: event_data, website_event, session, session_data, session_link,
-- session_replay, session_replay_saved, heatmap_event, revenue. There are no foreign keys (Prisma relationMode
-- "prisma"); the delete order is the one Umami's code uses.
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
    contributors bigint NOT NULL DEFAULT 0,
    total numeric,
    p50 numeric,
    p90 numeric,
    p99 numeric,
    PRIMARY KEY (month, website_id, metric, name, value, version, device)
);

CREATE TABLE IF NOT EXISTS nse_weekly (
    week date NOT NULL,
    website_id uuid NOT NULL,
    metric text NOT NULL,
    name text NOT NULL,
    n bigint NOT NULL,
    contributors bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (week, website_id, metric, name)
);

CREATE TEMP TABLE nse_cutoff ON COMMIT DROP AS SELECT now() - interval '13 months' AS earliest;

-- The complete months that are not final, and the totals they had.
CREATE TEMP TABLE nse_todo ON COMMIT DROP AS
SELECT DISTINCT e.website_id, date_trunc('month', e.created_at)::date AS month
FROM website_event e
WHERE e.created_at < date_trunc('month', now())
  AND NOT EXISTS (
      SELECT 1 FROM nse_monthly m
      WHERE m.metric = 'final' AND m.website_id = e.website_id AND m.month = date_trunc('month', e.created_at)::date
  );

DELETE FROM nse_monthly m USING nse_todo t WHERE m.website_id = t.website_id AND m.month = t.month;

-- The events and the data that the catalogue allows.
CREATE TEMP TABLE nse_ev ON COMMIT DROP AS
SELECT e.event_id, e.website_id, e.session_id, e.event_type,
       CASE WHEN e.event_type = 1 THEN 'pageview' ELSE e.event_name END AS name,
       t.month
FROM website_event e
JOIN nse_todo t ON t.website_id = e.website_id AND t.month = date_trunc('month', e.created_at)::date
WHERE e.event_type = 1
   OR (e.event_type = 2 AND e.event_name IN (SELECT event FROM nse_allowed WHERE event NOT LIKE '#%'));

CREATE TEMP TABLE nse_data ON COMMIT DROP AS
SELECT ev.month, ev.website_id, ev.session_id, ev.name, d.data_key, a.kind, d.string_value, d.number_value
FROM nse_ev ev
JOIN event_data d ON d.website_event_id = ev.event_id
JOIN nse_allowed a ON a.event = ev.name AND a.property = d.data_key
WHERE (a.kind = 'text' AND d.data_type = 1 AND d.string_value = a.value)
   OR (a.kind = 'pattern' AND d.data_type = 1 AND d.string_value ~ a.value)
   OR (a.kind = 'boolean' AND d.data_type = 3 AND d.string_value IN ('true', 'false'))
   OR (a.kind IN ('count', 'time') AND d.data_type = 2
       AND d.number_value BETWEEN 0 AND a.max AND d.number_value = trunc(d.number_value))
UNION ALL
SELECT ev.month, ev.website_id, ev.session_id, ev.name, d.data_key, 'count', d.string_value, d.number_value
FROM nse_ev ev
JOIN event_data d ON d.website_event_id = ev.event_id
JOIN nse_allowed a ON a.event = ev.name AND a.property = '*' AND a.kind = 'usage'
WHERE d.data_type = 2 AND d.data_key ~ a.value
  AND d.number_value BETWEEN 0 AND a.max AND d.number_value = trunc(d.number_value);

-- A session's version, if its visit events agree.
CREATE TEMP TABLE nse_version ON COMMIT DROP AS
SELECT session_id,
       CASE WHEN count(DISTINCT string_value) = 1 THEN min(string_value) ELSE 'mixed' END AS version
FROM nse_data
WHERE name = 'visit' AND data_key = 'version'
GROUP BY session_id;

-- One row for each session and month, with its columns checked against Umami's lists.
CREATE TEMP TABLE nse_sess ON COMMIT DROP AS
SELECT ev.month, ev.website_id, ev.session_id,
       count(*) FILTER (WHERE ev.event_type = 1) AS visits,
       coalesce(v.version, 'unknown') AS version,
       CASE WHEN s.browser IS NULL THEN 'unknown'
            WHEN s.browser IN (SELECT value FROM nse_allowed WHERE event = '#session' AND property = 'browser') THEN s.browser
            ELSE 'other' END AS browser,
       CASE WHEN s.os IS NULL THEN 'unknown'
            WHEN s.os IN (SELECT value FROM nse_allowed WHERE event = '#session' AND property = 'os') THEN s.os
            ELSE 'other' END AS os,
       CASE WHEN s.device IS NULL THEN 'unknown'
            WHEN s.device IN (SELECT value FROM nse_allowed WHERE event = '#session' AND property = 'device') THEN s.device
            ELSE 'other' END AS device,
       CASE WHEN s.country IS NULL THEN 'unknown'
            WHEN s.country ~ (SELECT value FROM nse_allowed WHERE event = '#session' AND property = 'country') THEN s.country
            ELSE 'other' END AS country,
       CASE WHEN s.language IS NULL THEN 'unknown'
            WHEN s.language ~ (SELECT value FROM nse_allowed WHERE event = '#session' AND property = 'language') THEN s.language
            ELSE 'other' END AS language
FROM nse_ev ev
LEFT JOIN session s ON s.session_id = ev.session_id
LEFT JOIN nse_version v ON v.session_id = ev.session_id
GROUP BY ev.month, ev.website_id, ev.session_id, v.version, s.browser, s.os, s.device, s.country, s.language;

-- Visits and sessions, one name at a time.
INSERT INTO nse_monthly (month, website_id, metric, name, value, n, contributors)
SELECT month, website_id, metric, name,
       CASE WHEN name = 'all' OR (ns >= 10 AND rk <= CASE WHEN name = 'country' THEN 100 ELSE 50 END)
            THEN value ELSE 'other' END,
       sum(n), sum(ns)
FROM (
    SELECT q.*, row_number() OVER (PARTITION BY month, website_id, metric, name ORDER BY ns DESC, value) AS rk
    FROM (
        SELECT g.month, g.website_id, m.metric, g.name, g.value,
               CASE WHEN m.metric = 'visits' THEN sum(g.visits) ELSE count(*) END AS n,
               count(*) FILTER (WHERE m.metric = 'sessions' OR g.visits > 0) AS ns
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
    ) q
) c
GROUP BY 1, 2, 3, 4, 5
HAVING sum(ns) >= 10 AND sum(n) > 0;

-- Events by name.
INSERT INTO nse_monthly (month, website_id, metric, name, n, contributors)
SELECT ev.month, ev.website_id, 'events', CASE WHEN en.ns >= 10 THEN ev.name ELSE 'other' END,
       count(*), count(DISTINCT ev.session_id)
FROM nse_ev ev
JOIN (
    SELECT month, website_id, name, count(DISTINCT session_id) AS ns FROM nse_ev GROUP BY 1, 2, 3
) en ON en.month = ev.month AND en.website_id = ev.website_id AND en.name = ev.name
GROUP BY 1, 2, 4
HAVING count(DISTINCT ev.session_id) >= 10;

-- Events by property and value, for text and flags.
INSERT INTO nse_monthly (month, website_id, metric, name, value, n, contributors)
SELECT d.month, d.website_id, 'value', d.name || '.' || d.data_key,
       CASE WHEN c.ns >= 10 AND (c.kind <> 'pattern' OR c.rk <= 50) THEN d.string_value ELSE 'other' END,
       count(*), count(DISTINCT d.session_id)
FROM nse_data d
JOIN (
    SELECT q.*,
           row_number() OVER (PARTITION BY month, website_id, name, data_key ORDER BY ns DESC, string_value) AS rk
    FROM (
        SELECT month, website_id, name, data_key, kind, string_value, count(DISTINCT session_id) AS ns
        FROM nse_data
        WHERE kind IN ('text', 'pattern', 'boolean')
        GROUP BY 1, 2, 3, 4, 5, 6
    ) q
) c ON c.month = d.month AND c.website_id = d.website_id AND c.name = d.name AND c.data_key = d.data_key
   AND c.string_value = d.string_value
WHERE d.kind IN ('text', 'pattern', 'boolean')
GROUP BY 1, 2, 4, 5
HAVING count(DISTINCT d.session_id) >= 10;

-- The counts: how many events carry the property, and the sum of its values.
INSERT INTO nse_monthly (month, website_id, metric, name, n, contributors, total)
SELECT month, website_id, 'number', name || '.' || data_key, count(*), count(DISTINCT session_id), round(sum(number_value))
FROM nse_data
WHERE kind = 'count'
GROUP BY month, website_id, name, data_key
HAVING count(DISTINCT session_id) >= 10;

-- The timings. A version (at most 50 a month) or a device class with fewer than 10 sessions is "other". The disjoint
-- groups of version by device class with fewer than 10 sessions are left out, and every row that is published, overall,
-- by version, by device class and by both, is made only from the measurements of the groups that are kept. A left-out
-- measurement is in no row, so no percentile can be turned back into it.
CREATE TEMP TABLE nse_t ON COMMIT DROP AS
SELECT d.month, d.website_id, d.session_id, d.name || '.' || d.data_key AS prop, d.number_value::float8 AS x,
       s.version AS ver, s.device AS dev
FROM nse_data d
JOIN nse_sess s ON s.month = d.month AND s.website_id = d.website_id AND s.session_id = d.session_id
WHERE d.kind = 'time';

CREATE TEMP TABLE nse_tmap ON COMMIT DROP AS
SELECT t.month, t.website_id, t.session_id, t.prop, t.x,
       CASE WHEN v.ns >= 10 AND v.rk <= 50 THEN t.ver ELSE 'other' END AS ver,
       CASE WHEN dv.ns >= 10 THEN t.dev ELSE 'other' END AS dev
FROM nse_t t
JOIN (
    SELECT q.*, row_number() OVER (PARTITION BY month, website_id, prop ORDER BY ns DESC, ver) AS rk
    FROM (
        SELECT month, website_id, prop, ver, count(DISTINCT session_id) AS ns FROM nse_t GROUP BY 1, 2, 3, 4
    ) q
) v ON v.month = t.month AND v.website_id = t.website_id AND v.prop = t.prop AND v.ver = t.ver
JOIN (
    SELECT month, website_id, prop, dev, count(DISTINCT session_id) AS ns FROM nse_t GROUP BY 1, 2, 3, 4
) dv ON dv.month = t.month AND dv.website_id = t.website_id AND dv.prop = t.prop AND dv.dev = t.dev;

CREATE TEMP TABLE nse_tkept ON COMMIT DROP AS
SELECT t.month, t.website_id, t.session_id, t.prop, t.x, t.ver, t.dev
FROM nse_tmap t
JOIN (
    SELECT month, website_id, prop, ver, dev
    FROM nse_tmap
    GROUP BY 1, 2, 3, 4, 5
    HAVING count(DISTINCT session_id) >= 10
) k ON k.month = t.month AND k.website_id = t.website_id AND k.prop = t.prop AND k.ver = t.ver AND k.dev = t.dev;

INSERT INTO nse_monthly (month, website_id, metric, name, version, device, n, contributors, p50, p90, p99)
SELECT t.month, t.website_id, 'time', t.prop, g.ver, g.dev, count(*), count(DISTINCT t.session_id),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.x)),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY t.x)),
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY t.x))
FROM nse_tkept t
CROSS JOIN LATERAL (VALUES ('', ''), (t.ver, ''), ('', t.dev), (t.ver, t.dev)) g(ver, dev)
GROUP BY t.month, t.website_id, t.prop, g.ver, g.dev
HAVING count(DISTINCT t.session_id) >= 10;

-- The weekly counts. A complete week is one before this week. Its rows are made again from the raw records until a
-- record of it is deleted, as the months are.
CREATE TEMP TABLE nse_wtodo ON COMMIT DROP AS
SELECT DISTINCT e.website_id, date_trunc('week', e.created_at)::date AS week
FROM website_event e
WHERE e.created_at < date_trunc('week', now())
  AND NOT EXISTS (
      SELECT 1 FROM nse_weekly w
      WHERE w.metric = 'final' AND w.website_id = e.website_id AND w.week = date_trunc('week', e.created_at)::date
  );

DELETE FROM nse_weekly w USING nse_wtodo t WHERE w.website_id = t.website_id AND w.week = t.week;

CREATE TEMP TABLE nse_wev ON COMMIT DROP AS
SELECT e.website_id, e.session_id, e.event_type,
       CASE WHEN e.event_type = 1 THEN 'pageview' ELSE e.event_name END AS name,
       t.week
FROM website_event e
JOIN nse_wtodo t ON t.website_id = e.website_id AND t.week = date_trunc('week', e.created_at)::date
WHERE e.event_type = 1
   OR (e.event_type = 2 AND e.event_name IN (SELECT event FROM nse_allowed WHERE event NOT LIKE '#%'));

INSERT INTO nse_weekly (week, website_id, metric, name, n, contributors)
SELECT week, website_id, 'visits', 'all', count(*), count(DISTINCT session_id)
FROM nse_wev
WHERE event_type = 1
GROUP BY week, website_id
HAVING count(DISTINCT session_id) >= 10;

INSERT INTO nse_weekly (week, website_id, metric, name, n, contributors)
SELECT week, website_id, 'sessions', 'all', count(DISTINCT session_id), count(DISTINCT session_id)
FROM nse_wev
GROUP BY week, website_id
HAVING count(DISTINCT session_id) >= 10;

INSERT INTO nse_weekly (week, website_id, metric, name, n, contributors)
SELECT ev.week, ev.website_id, 'events', CASE WHEN en.ns >= 10 THEN ev.name ELSE 'other' END,
       count(*), count(DISTINCT ev.session_id)
FROM nse_wev ev
JOIN (
    SELECT week, website_id, name, count(DISTINCT session_id) AS ns FROM nse_wev GROUP BY 1, 2, 3
) en ON en.week = ev.week AND en.website_id = ev.website_id AND en.name = ev.name
GROUP BY 1, 2, 4
HAVING count(DISTINCT ev.session_id) >= 10;

INSERT INTO nse_weekly (week, website_id, metric, name, n)
SELECT t.week, t.website_id, 'final', '', 0
FROM nse_wtodo t
WHERE EXISTS (
    SELECT 1 FROM website_event e
    WHERE e.website_id = t.website_id
      AND e.created_at >= t.week::timestamptz
      AND e.created_at < least((t.week + interval '7 days')::timestamptz, (SELECT earliest FROM nse_cutoff))
);

-- A month with a record that goes now is final: it is not totalled again. A month that has only records after the
-- cutoff is not, so a report that arrives late is still counted.
INSERT INTO nse_monthly (month, website_id, metric, name, n)
SELECT t.month, t.website_id, 'final', '', 0
FROM nse_todo t
WHERE EXISTS (
    SELECT 1 FROM website_event e
    WHERE e.website_id = t.website_id
      AND e.created_at >= t.month::timestamptz
      AND e.created_at < least((t.month + interval '1 month')::timestamptz, (SELECT earliest FROM nse_cutoff))
);

-- Every month before the cutoff has its totals, and is final. Events and their data go first, then the sessions that
-- have no event left, with what hangs off them.
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
DELETE FROM heatmap_event WHERE session_id IN (SELECT session_id FROM nse_gone) OR created_at < (SELECT earliest FROM nse_cutoff);
DELETE FROM revenue WHERE session_id IN (SELECT session_id FROM nse_gone) OR created_at < (SELECT earliest FROM nse_cutoff);
DELETE FROM session WHERE session_id IN (SELECT session_id FROM nse_gone);
