-- Engaged visits per day (a pageview is sent only after the first real interaction), by country.
SELECT e.created_at::date AS day, coalesce(s.country, '??') AS country, count(*) AS visits
FROM website_event e
JOIN session s ON s.session_id = e.session_id
WHERE e.website_id = :'website' AND e.event_type = 1
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;
