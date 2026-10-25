-- The most common value of each setting in the visit snapshot.
SELECT d.data_key AS setting,
       coalesce(d.string_value, d.number_value::text) AS value,
       count(*) AS visits
FROM website_event e
JOIN event_data d ON d.website_event_id = e.event_id
WHERE e.website_id = :'website' AND e.event_name = 'settings'
GROUP BY 1, 2
ORDER BY 1, 3 DESC;
