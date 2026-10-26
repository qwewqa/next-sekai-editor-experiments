-- The monthly totals that stay after the raw records are deleted (nse_monthly, written by the nightly job; it exists
-- after the first nightly run). A complete month appears after the next run and is made again each night until it is
-- final. The totals hold no session or visit code, and only rows with 10 or more sessions behind them.
-- 1. Per month: engaged visits, sessions (per day) and events.
-- 2. Per month and editor version: visits.
-- 3. The timings, per month, in milliseconds: p50, p90 and p99 over all versions and devices.
SELECT m.month,
       coalesce(sum(m.n) FILTER (WHERE m.metric = 'visits'), 0) AS visits,
       coalesce(sum(m.n) FILTER (WHERE m.metric = 'sessions'), 0) AS sessions,
       (SELECT coalesce(sum(e.n), 0) FROM nse_monthly e
         WHERE e.website_id = m.website_id AND e.month = m.month AND e.metric = 'events') AS events
FROM nse_monthly m
WHERE m.website_id = :'website' AND m.metric IN ('visits', 'sessions') AND m.name = 'all'
GROUP BY m.website_id, m.month
ORDER BY m.month DESC;

SELECT month, value AS version, n AS visits
FROM nse_monthly
WHERE website_id = :'website' AND metric = 'visits' AND name = 'version'
ORDER BY month DESC, n DESC, value;

SELECT month, name AS timing, n, p50::int, p90::int, p99::int
FROM nse_monthly
WHERE website_id = :'website' AND metric = 'time' AND version = '' AND device = ''
ORDER BY month DESC, name;
