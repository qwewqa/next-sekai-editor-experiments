-- Umami adds a region and a city to each session from the IP address. Only the country is kept, so the database never
-- stores the two. Safe to run again. update.sh runs it after every update, because a migration can recreate the table.
-- Run it with psql -1. Rows stored before the trigger existed are cleared by `nightly.sh clean`.
CREATE OR REPLACE FUNCTION nse_drop_geo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.region := NULL;
    NEW.city := NULL;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS nse_drop_geo ON session;
CREATE TRIGGER nse_drop_geo BEFORE INSERT OR UPDATE ON session FOR EACH ROW EXECUTE FUNCTION nse_drop_geo();
