package com.gaomu.suji.workshop.data.source

import java.io.File

data class SourceCandidate(
    val uri: String,
    val displayName: String,
)

fun distinctUriStrings(uris: List<String>): List<String> =
    uris.distinctBy { it.trim() }

fun distinctSourceCandidates(candidates: List<SourceCandidate>): List<SourceCandidate> =
    candidates.distinctBy { it.uri.trim() }

fun isAppOwnedSource(candidate: File, filesDir: File, cacheDir: File): Boolean {
    val path = candidate.canonicalFile.toPath()
    val sourcesPath = File(filesDir, "sources").canonicalFile.toPath()
    val cachePath = cacheDir.canonicalFile.toPath()
    return path.startsWith(sourcesPath) || path.startsWith(cachePath)
}
