package com.gaomu.suji.workshop.data.source

import org.junit.Assert.assertEquals
import org.junit.Test

class SourceSelectionTest {
    @Test
    fun distinctUriStrings_removesRepeatedUrisButKeepsOrder() {
        val actual =
            distinctUriStrings(
                listOf(
                    "content://docs/image-1",
                    "content://docs/image-1",
                    "content://docs/image-2",
                ),
            )

        assertEquals(
            listOf("content://docs/image-1", "content://docs/image-2"),
            actual,
        )
    }

    @Test
    fun distinctSourceCandidates_keepsSameNameFromDifferentUris() {
        val actual =
            distinctSourceCandidates(
                listOf(
                    SourceCandidate("content://docs/a", "861.jpg"),
                    SourceCandidate("content://docs/a", "861.jpg"),
                    SourceCandidate("content://docs/b", "861.jpg"),
                ),
            )

        assertEquals(
            listOf(
                SourceCandidate("content://docs/a", "861.jpg"),
                SourceCandidate("content://docs/b", "861.jpg"),
            ),
            actual,
        )
    }
}
