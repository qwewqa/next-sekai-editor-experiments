-- Timeline steps shown, by the time they took (a range) or from the cache, most common first.
SELECT substring(d.data_key from '^peek\.(.*)$') AS time_range,
       sum(d.number_value)::int AS steps
FROM website_event e
JOIN event_data d ON d.website_event_id = e.event_id
WHERE e.website_id = :'website' AND e.event_name = 'peek' AND d.data_key LIKE 'peek.%'
GROUP BY 1
ORDER BY 2 DESC, 1;
