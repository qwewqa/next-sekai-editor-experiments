-- The weekly counts that stay after the raw records are deleted (nse_weekly, written by the nightly job; it exists after
-- the first nightly run). Weeks are ISO weeks in UTC, named by their Monday, so they have an even length. A complete
-- week appears after the next run and is made again each night until it is final. Only rows with 10 or more sessions
-- behind them are kept.
-- 1. Per week: engaged visits and sessions (per day), for the trend line.
-- 2. Per week and event name: how many events, for the trend of each kind of report.
SELECT w.week,
       coalesce(sum(w.n) FILTER (WHERE w.metric = 'visits'), 0) AS visits,
       coalesce(sum(w.n) FILTER (WHERE w.metric = 'sessions'), 0) AS sessions
FROM nse_weekly w
WHERE w.website_id = :'website' AND w.metric IN ('visits', 'sessions') AND w.name = 'all'
GROUP BY w.week
ORDER BY w.week DESC;

SELECT week, name AS event, n AS events
FROM nse_weekly
WHERE website_id = :'website' AND metric = 'events'
ORDER BY week DESC, n DESC, name;
