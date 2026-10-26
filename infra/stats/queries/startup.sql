-- Startup time ("ready", whole milliseconds) by how the page was loaded: the navigation type and how the
-- document was delivered. "timed" counts the startups that have a time; a hidden or failed start has none.
-- The last column is the share of timed startups that took 10 seconds or more.
WITH startups AS (
    SELECT max(d.string_value) FILTER (WHERE d.data_key = 'navigation') AS navigation,
           max(d.string_value) FILTER (WHERE d.data_key = 'documentDelivery') AS delivery,
           max(d.number_value) FILTER (WHERE d.data_key = 'ready')::float8 AS ready
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'startup'
    GROUP BY e.event_id
)
SELECT coalesce(navigation, 'unknown') AS navigation,
       coalesce(delivery, 'unknown') AS delivery,
       count(*) AS startups,
       count(ready) AS timed,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ready))::int AS p50,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY ready))::int AS p75,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY ready))::int AS p90,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ready))::int AS p95,
       round(100.0 * count(*) FILTER (WHERE ready >= 10000) / nullif(count(ready), 0)) AS pct_10s_or_more
FROM startups
GROUP BY 1, 2
ORDER BY 3 DESC, 1, 2;

-- Notes in the charts restored, most common first.
WITH charts AS (
    SELECT max(d.string_value) FILTER (WHERE d.data_key = 'notes') AS notes
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'chart'
    GROUP BY e.event_id
    HAVING max(d.string_value) FILTER (WHERE d.data_key = 'trigger') = 'restore'
)
SELECT coalesce(notes, 'none') AS notes, count(*) AS restores
FROM charts
GROUP BY 1
ORDER BY 2 DESC, 1;
