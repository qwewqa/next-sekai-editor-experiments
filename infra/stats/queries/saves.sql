-- Save outcomes by target and reason.
WITH saves AS (
    SELECT e.event_id,
           max(d.string_value) FILTER (WHERE d.data_key = 'target') AS target,
           max(d.string_value) FILTER (WHERE d.data_key = 'outcome') AS outcome,
           max(d.string_value) FILTER (WHERE d.data_key = 'reason') AS reason
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'save'
    GROUP BY e.event_id
)
SELECT target, outcome, coalesce(reason, '') AS reason, count(*) AS saves
FROM saves
GROUP BY 1, 2, 3
ORDER BY saves DESC;
