-- Commands ranked by use. A usage event has one property per command and source ("<command>.<source>"),
-- holding the press count. "visitors" counts the sessions that pressed it, per day.
SELECT regexp_replace(d.data_key, '\.[^.]*$', '') AS command,
       substring(d.data_key from '[^.]*$') AS source,
       sum(d.number_value)::int AS presses,
       count(DISTINCT e.session_id) AS visitors
FROM website_event e
JOIN event_data d ON d.website_event_id = e.event_id
WHERE e.website_id = :'website' AND e.event_name = 'usage'
GROUP BY 1, 2
ORDER BY presses DESC;
