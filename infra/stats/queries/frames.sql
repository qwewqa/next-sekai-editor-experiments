-- Long frames per playback second, by the preview host. A perf event counts long frames in buckets
-- ("frames.playing.<bucket>") and the playback seconds; the host is the visit's last preview event.
WITH perf AS (
    SELECT e.session_id, e.created_at::date AS day,
           sum(d.number_value) FILTER (WHERE d.data_key LIKE 'frames.playing.%') AS long_frames,
           max(d.number_value) FILTER (WHERE d.data_key = 'playSeconds') AS play_seconds
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'perf'
    GROUP BY e.event_id, e.session_id, day
), hosts AS (
    SELECT DISTINCT ON (e.session_id, e.created_at::date)
           e.session_id, e.created_at::date AS day, d.string_value AS host
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'preview' AND d.data_key = 'host'
    ORDER BY e.session_id, e.created_at::date, e.created_at DESC
)
SELECT coalesce(h.host, 'unknown') AS host,
       count(*) AS visits,
       sum(p.long_frames)::int AS long_frames,
       sum(p.play_seconds)::int AS play_seconds,
       round(sum(p.long_frames) / nullif(sum(p.play_seconds), 0), 3) AS long_frames_per_second
FROM perf p
LEFT JOIN hosts h USING (session_id, day)
WHERE p.play_seconds > 0
GROUP BY 1
ORDER BY 2 DESC;
