-- Startup time (the ready bucket) by how the visit started and by the size of the chart it restored.
-- The chart is the visit's restore event; a visit that restored nothing has no size.
WITH startups AS (
    SELECT e.session_id, e.created_at::date AS day,
           max(d.string_value) FILTER (WHERE d.data_key = 'start') AS start,
           max(d.string_value) FILTER (WHERE d.data_key = 'ready') AS ready
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'startup'
    GROUP BY e.event_id, e.session_id, day
), charts AS (
    SELECT e.session_id, e.created_at::date AS day,
           max(d.string_value) FILTER (WHERE d.data_key = 'notes') AS notes
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'chart'
    GROUP BY e.event_id, e.session_id, day
    HAVING max(d.string_value) FILTER (WHERE d.data_key = 'trigger') = 'restore'
)
SELECT s.start, coalesce(c.notes, 'none') AS notes, coalesce(s.ready, 'hidden') AS ready, count(*) AS visits
FROM startups s
LEFT JOIN charts c USING (session_id, day)
GROUP BY 1, 2, 3
ORDER BY 1, 2, visits DESC;
