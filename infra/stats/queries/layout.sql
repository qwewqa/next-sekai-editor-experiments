-- Where the panels were, and how big, as shares of time (not of people). A layout event counts seconds and
-- leaves out a counter that was 0, which counts as 0. Events whose visibleTime reached the cap of a day are
-- left out of every figure. Divide by visibleTime, the time the layout was counted, and not by perf's.
-- A row stands for 10 or more distinct sessions (`sessions`, a stand-in for people). A cell with fewer is left out,
-- and the size and share distributions divide by the cells that are printed, so a left-out cell cannot be found by
-- subtraction.

-- Each panel on each side, or covered (open, with no room to show it), as a share of the time counted.
WITH counted AS (
    SELECT e.event_id, e.session_id, d.number_value AS visible
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
), total AS (
    SELECT sum(visible) AS seconds FROM counted
)
SELECT substring(d.data_key from '^panelSeconds\.([a-z]+)\.') AS panel,
       substring(d.data_key from '^panelSeconds\.[a-z]+\.([a-z]+)$') AS place,
       count(DISTINCT c.session_id) AS sessions,
       sum(d.number_value)::int AS seconds,
       round(100 * sum(d.number_value) / nullif((SELECT seconds FROM total), 0), 1) AS percent_of_time
FROM counted c
JOIN event_data d ON d.website_event_id = c.event_id
WHERE d.data_key LIKE 'panelSeconds.%' AND d.number_value > 0
GROUP BY 1, 2
HAVING count(DISTINCT c.session_id) >= 10
ORDER BY 1, 2;

-- The width of the left and right panels, or the height of the top panels, by the time spent at each size, as a
-- share of the time that side showed a body, among the sizes printed.
WITH counted AS (
    SELECT e.event_id, e.session_id
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
), cells AS (
    SELECT substring(d.data_key from '^dockSizeSeconds\.([a-z]+)\.') AS side,
           substring(d.data_key from '^dockSizeSeconds\.[a-z]+\.(.*)$') AS dock_size,
           count(DISTINCT c.session_id) AS sessions,
           sum(d.number_value) AS seconds
    FROM counted c
    JOIN event_data d ON d.website_event_id = c.event_id
    WHERE d.data_key LIKE 'dockSizeSeconds.%' AND d.number_value > 0
    GROUP BY 1, 2
    HAVING count(DISTINCT c.session_id) >= 10
)
SELECT side, dock_size, sessions, seconds::int AS seconds,
       round(100 * seconds / sum(seconds) OVER (PARTITION BY side), 1) AS percent_of_side
FROM cells
ORDER BY side, substring(dock_size from '^[0-9]+')::int;

-- Preview's share of the workspace's area, by the time spent at each share, as a share of the time it was shown,
-- among the shares printed.
WITH counted AS (
    SELECT e.event_id, e.session_id
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
), cells AS (
    SELECT substring(d.data_key from '^previewShareSeconds\.(.*)$') AS area_share,
           count(DISTINCT c.session_id) AS sessions,
           sum(d.number_value) AS seconds
    FROM counted c
    JOIN event_data d ON d.website_event_id = c.event_id
    WHERE d.data_key LIKE 'previewShareSeconds.%' AND d.number_value > 0
    GROUP BY 1
    HAVING count(DISTINCT c.session_id) >= 10
)
SELECT area_share, sessions, seconds::int AS seconds,
       round(100 * seconds / sum(seconds) OVER (), 1) AS percent_of_shown
FROM cells
ORDER BY substring(area_share from '^[0-9]+')::int;

-- Time with a panel shown over the chart (drawer), panels hidden by choice (collapsed) or by the editor
-- (suppressed), and Groups and Stages side by side (paired), as a share of the time counted. Each counts
-- time with any such panel, so they overlap.
WITH counted AS (
    SELECT e.event_id, e.session_id, d.number_value AS visible
    FROM website_event e
    JOIN event_data d ON d.website_event_id = e.event_id
    WHERE e.website_id = :'website' AND e.event_name = 'layout'
      AND d.data_key = 'visibleTime' AND d.number_value < 86400
), total AS (
    SELECT sum(visible) AS seconds FROM counted
)
SELECT d.data_key AS condition,
       count(DISTINCT c.session_id) AS sessions,
       sum(d.number_value)::int AS seconds,
       round(100 * sum(d.number_value) / nullif((SELECT seconds FROM total), 0), 1) AS percent_of_time
FROM counted c
JOIN event_data d ON d.website_event_id = c.event_id
WHERE d.data_key IN ('drawerSeconds', 'collapsedSeconds', 'suppressedSeconds', 'pairedSeconds')
  AND d.number_value > 0
GROUP BY 1
HAVING count(DISTINCT c.session_id) >= 10
ORDER BY 1;
