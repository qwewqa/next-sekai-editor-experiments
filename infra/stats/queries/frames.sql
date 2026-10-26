-- Long frames per minute of visible playback, by the preview host and render scale. A perf event counts
-- long frames while playing ("frames.playing.<range>") and the visible playback seconds. Only summaries from
-- a browser that reports long frames (loafSupported) with every frame sorted by when it began
-- (frameAttribution "full") count.
WITH perf AS (
    SELECT e.event_id,
           coalesce(bool_or(d.string_value = 'true') FILTER (WHERE d.data_key = 'loafSupported'), false) AS supported,
           max(d.string_value) FILTER (WHERE d.data_key = 'frameAttribution') AS attribution,
           max(d.string_value) FILTER (WHERE d.data_key = 'previewHost') AS host,
           max(d.string_value) FILTER (WHERE d.data_key = 'previewRenderScale') AS render_scale,
           sum(d.number_value) FILTER (WHERE d.data_key LIKE 'frames.playing.%') AS long_frames,
           max(d.number_value) FILTER (WHERE d.data_key = 'playSeconds') AS play_seconds
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'perf'
    GROUP BY e.event_id
)
SELECT coalesce(host, 'unknown') AS host,
       coalesce(render_scale, 'unknown') AS render_scale,
       count(*) AS summaries,
       sum(long_frames)::int AS long_frames,
       sum(play_seconds)::int AS play_seconds,
       round(60 * sum(long_frames) / nullif(sum(play_seconds), 0), 2) AS long_frames_per_minute
FROM perf
WHERE supported AND attribution = 'full' AND play_seconds > 0
GROUP BY 1, 2
ORDER BY 3 DESC, 1, 2;

-- What the figures above leave out: summaries with playback that are not counted, as a count and a share.
WITH perf AS (
    SELECT coalesce(bool_or(d.string_value = 'true') FILTER (WHERE d.data_key = 'loafSupported'), false) AS supported,
           max(d.string_value) FILTER (WHERE d.data_key = 'frameAttribution') AS attribution,
           max(d.number_value) FILTER (WHERE d.data_key = 'playSeconds') AS play_seconds
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'perf'
    GROUP BY e.event_id
)
SELECT count(*) AS summaries_with_playback,
       count(*) FILTER (WHERE NOT (supported AND attribution = 'full')) AS left_out,
       round(100.0 * count(*) FILTER (WHERE NOT (supported AND attribution = 'full')) / count(*)) AS left_out_percent
FROM perf
WHERE play_seconds > 0;
