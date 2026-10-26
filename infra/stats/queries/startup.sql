-- Startups by how the visit started and the startup time (the ready bucket), then the sizes of the
-- charts restored. The two are separate: nothing in the events says which restore belongs to which startup.
WITH startups AS (
    SELECT max(d.string_value) FILTER (WHERE d.data_key = 'start') AS start,
           max(d.string_value) FILTER (WHERE d.data_key = 'ready') AS ready
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'startup'
    GROUP BY e.event_id
)
SELECT coalesce(start, 'unknown') AS start, coalesce(ready, 'hidden') AS ready, count(*) AS startups
FROM startups
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

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
ORDER BY 2 DESC;
