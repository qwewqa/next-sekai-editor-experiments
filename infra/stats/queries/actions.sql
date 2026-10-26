-- How long actions take ("took", whole milliseconds), by action, target and the size range of the file,
-- for the ones that finished. A Save has an action and a target, an Export a target; Open, Check and BGM have
-- neither. A Check has a size only when it read the file.
WITH actions AS (
    SELECT e.event_name AS event,
           max(d.string_value) FILTER (WHERE d.data_key = 'action') AS action,
           max(d.string_value) FILTER (WHERE d.data_key = 'target') AS target,
           max(d.string_value) FILTER (WHERE d.data_key = 'size') AS size,
           max(d.string_value) FILTER (WHERE d.data_key = 'outcome') AS outcome,
           max(d.number_value) FILTER (WHERE d.data_key = 'took')::float8 AS took
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name IN ('open', 'save', 'export', 'check', 'bgm')
    GROUP BY e.event_id, e.event_name
)
SELECT event,
       coalesce(action, '') AS action,
       coalesce(target, '') AS target,
       coalesce(size, 'unknown') AS size,
       count(*) AS actions,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY took))::int AS p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY took))::int AS p90
FROM actions
WHERE outcome IN ('done', 'ok', 'problems') AND took IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 5 DESC, 4;
