-- A title's name and synopsis in the languages Văzute publishes pages in.
--
-- `media` holds TMDB's English text, which is what the application has always
-- shown. The public title pages are published in Romanian as well, and a
-- Romanian page that only carries an English synopsis says nothing a search
-- in Romanian would find. TMDB already sends every translation with the detail
-- response the refresh fetches — the titles were kept, for search, in
-- `media_title_aliases`; the synopses were thrown away.
--
-- One row per title and language, only where TMDB has a translation. Either
-- field may be missing: plenty of titles have a Romanian name and no Romanian
-- synopsis, and a page falls back to the English text for whichever is absent.
CREATE TABLE media_localizations (
    media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    language_code VARCHAR(2) NOT NULL,
    title VARCHAR(500),
    overview TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (media_id, language_code),
    CONSTRAINT media_localization_language_shape CHECK (language_code ~ '^[a-z]{2}$'),
    CONSTRAINT media_localization_has_text CHECK (title IS NOT NULL OR overview IS NOT NULL)
);

-- When the translations were last read, whether or not there were any. NULL
-- marks a title refreshed before this table existed: catalog hydration picks
-- those up first, the same way it backfilled `title_aliases_cached_at`.
ALTER TABLE media ADD COLUMN localizations_cached_at TIMESTAMPTZ;
