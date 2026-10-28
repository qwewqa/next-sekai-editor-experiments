-- Where the panels were, and how big, as shares of time (not of people). A layout event counts seconds and
-- leaves out a counter that was 0, which counts as 0. Events whose visibleTime reached the cap of a day are
-- left out of every figure. Divide by visibleTime, the time the layout was counted, and not by perf's.

-- Each panel on each side, or covered (open, with no room to show it), as a share of the time counted.
WITH counted AS (
    SELECT e.event_id, d.number_value AS visible
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
)
SELECT substring(d.data_key from '^panelSeconds\.([a-z]+)\.') AS panel,
       substring(d.data_key from '^panelSeconds\.[a-z]+\.([a-z]+)$') AS place,
       sum(d.number_value)::int AS seconds,
       round(100 * sum(d.number_value) / nullif((SELECT sum(visible) FROM counted), 0), 1) AS percent_of_time
FROM counted c
JOIN event_data d ON d.website_event_id = c.event_id
WHERE d.data_key LIKE 'panelSeconds.%'
GROUP BY 1, 2
ORDER BY 1, 2;

-- The width of the left and right panels, or the height of the top panels, by the time spent at each size,
-- as a share of the time that side showed a body.
WITH counted AS (
    SELECT e.event_id
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
), sizes AS (
    SELECT substring(d.data_key from '^dockSizeSeconds\.([a-z]+)\.') AS side,
           substring(d.data_key from '^dockSizeSeconds\.[a-z]+\.(.*)$') AS size,
           sum(d.number_value) AS seconds
    FROM counted c
    JOIN event_data d ON d.website_event_id = c.event_id
    WHERE d.data_key LIKE 'dockSizeSeconds.%'
    GROUP BY 1, 2
)
SELECT side, size, seconds::int AS seconds,
       round(100 * seconds / sum(seconds) OVER (PARTITION BY side), 1) AS percent_of_side
FROM sizes
ORDER BY side, substring(size from '^[0-9]+')::int;

-- Preview's share of the workspace's area, by the time spent at each share, as a share of the time it was shown.
WITH counted AS (
    SELECT e.event_id
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
), shares AS (
    SELECT substring(d.data_key from '^previewShareSeconds\.(.*)$') AS share,
           sum(d.number_value) AS seconds
    FROM counted c
    JOIN event_data d ON d.website_event_id = c.event_id
    WHERE d.data_key LIKE 'previewShareSeconds.%'
    GROUP BY 1
)
SELECT share, seconds::int AS seconds,
       round(100 * seconds / sum(seconds) OVER (), 1) AS percent_of_shown
FROM shares
ORDER BY substring(share from '^[0-9]+')::int;

-- Time with a panel shown over the chart (drawer), panels hidden by choice (collapsed) or by the editor
-- (suppressed), and Groups and Stages side by side (paired), as a share of the time counted. Each counts
-- time with any such panel, so they overlap.
WITH counted AS (
    SELECT e.event_id, d.number_value AS visible
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
)
SELECT d.data_key AS condition,
       sum(d.number_value)::int AS seconds,
       round(100 * sum(d.number_value) / nullif((SELECT sum(visible) FROM counted), 0), 1) AS percent_of_time
FROM counted c
JOIN event_data d ON d.website_event_id = c.event_id
WHERE d.data_key IN ('drawerSeconds', 'collapsedSeconds', 'suppressedSeconds', 'pairedSeconds')
GROUP BY 1
ORDER BY 1;
