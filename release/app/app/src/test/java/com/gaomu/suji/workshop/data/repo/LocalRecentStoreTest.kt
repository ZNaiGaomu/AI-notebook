package com.gaomu.suji.workshop.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LocalRecentStoreTest {
    @Test
    fun exactClientSourceIdBeatsDestinationFallback() {
        val list =
            listOf(
                entry(clientSourceId = "A", kind = "file", preview = "a.jpg", destPath = "note.md", originalUri = "content://a"),
                entry(clientSourceId = "B", kind = "file", preview = "b.jpg", destPath = "note.md", originalUri = "content://b"),
            )
        val hit = matchLocalRecentEntry(list, "B", "file", "b.jpg", "note.md")
        assertEquals("B", hit?.clientSourceId)
        assertEquals("content://b", hit?.originalUri)
    }

    @Test
    fun nonblankUnknownClientSourceIdDoesNotFallBack() {
        val list =
            listOf(
                entry(clientSourceId = "A", kind = "file", preview = "a.jpg", destPath = "note.md"),
            )
        val hit = matchLocalRecentEntry(list, "missing", "file", "a.jpg", "note.md")
        assertNull(hit)
    }

    @Test
    fun blankClientSourceIdRequiresUniqueStrongComposite() {
        val list =
            listOf(
                entry(clientSourceId = "", kind = "file", preview = "shot.jpg", destPath = "note.md", originalUri = "content://1"),
            )
        val hit = matchLocalRecentEntry(list, "", "file", "shot.jpg", "note.md")
        assertEquals("content://1", hit?.originalUri)
    }

    @Test
    fun ambiguousStrongCompositeReturnsNull() {
        val list =
            listOf(
                entry(clientSourceId = "", kind = "file", preview = "shot.jpg", destPath = "note.md", originalUri = "content://1"),
                entry(clientSourceId = "", kind = "file", preview = "shot.jpg", destPath = "note.md", originalUri = "content://2"),
            )
        val hit = matchLocalRecentEntry(list, "", "file", "shot.jpg", "note.md")
        assertNull(hit)
    }

    @Test
    fun noFirstRowFallbackOnPartialIdentity() {
        val list =
            listOf(
                entry(clientSourceId = "", kind = "file", preview = "shot.jpg", destPath = "other.md"),
            )
        val hit = matchLocalRecentEntry(list, "", "file", "shot.jpg", "")
        assertNull(hit)
    }

    @Test
    fun originalMetadataAllowsExactAndUnavailableLegacyFields() {
        val stored = OriginalSourceMetadata("shot.jpg", 123L, "image/jpeg")
        assertEquals(
            true,
            originalSourceMetadataMatches(
                stored,
                OriginalSourceMetadata("shot.jpg", 123L, "image/jpeg"),
            ),
        )
        assertEquals(
            true,
            originalSourceMetadataMatches(stored, OriginalSourceMetadata()),
        )
    }

    @Test
    fun originalMetadataRejectsClearNameSizeAndMimeMismatches() {
        val stored = OriginalSourceMetadata("shot.jpg", 123L, "image/jpeg")
        assertEquals(
            false,
            originalSourceMetadataMatches(
                stored,
                OriginalSourceMetadata("other.jpg", 123L, "image/jpeg"),
            ),
        )
        assertEquals(
            false,
            originalSourceMetadataMatches(
                stored,
                OriginalSourceMetadata("shot.jpg", 999L, "image/jpeg"),
            ),
        )
        assertEquals(
            false,
            originalSourceMetadataMatches(
                stored,
                OriginalSourceMetadata("shot.jpg", 123L, "video/mp4"),
            ),
        )
    }

    private fun entry(
        clientSourceId: String,
        kind: String,
        preview: String,
        destPath: String,
        originalUri: String = "",
    ): LocalRecentEntry =
        LocalRecentEntry(
            clientSourceId = clientSourceId,
            kind = kind,
            title = preview,
            preview = preview,
            originalUri = originalUri,
            originalDisplayName = preview,
            destPath = destPath,
        )
}
