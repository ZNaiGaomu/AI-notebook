package com.gaomu.suji.workshop.data.source

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalSourcePolicyTest {
    private val filesDir = File("C:/app/files")
    private val cacheDir = File("C:/app/cache")

    @Test
    fun isAppOwnedSource_acceptsSourcesAndDedicatedCacheChildren() {
        assertTrue(
            isAppOwnedSource(
                File("C:/app/files/sources/861.jpg"),
                filesDir,
                File(cacheDir, "sources"),
            ),
        )
        assertTrue(
            isAppOwnedSource(
                File("C:/app/cache/sources/861.jpg"),
                filesDir,
                File(cacheDir, "sources"),
            ),
        )
    }

    @Test
    fun isAppOwnedSource_rejectsOtherPrivateAndExternalFiles() {
        assertFalse(
            isAppOwnedSource(
                File("C:/app/files/local_recent.json"),
                filesDir,
                File(cacheDir, "sources"),
            ),
        )
        assertFalse(
            isAppOwnedSource(
                File("C:/app/cache/import/861.jpg"),
                filesDir,
                File(cacheDir, "sources"),
            ),
        )
        assertFalse(
            isAppOwnedSource(
                File("C:/shared/861.jpg"),
                filesDir,
                File(cacheDir, "sources"),
            ),
        )
    }
}
