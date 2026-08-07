package com.gaomu.suji.workshop.data.repo

/**
 * Shared pure matcher for mapping a server recent row to a phone-local source entry.
 *
 * Rules:
 * - nonblank clientSourceId must match exactly; no weaker fallback
 * - blank clientSourceId requires a unique kind + destPath + source-descriptor match
 * - ambiguous or incomplete identity returns null rather than the first row
 */
fun matchLocalRecentEntry(
    list: List<LocalRecentEntry>,
    clientSourceId: String,
    kind: String,
    preview: String,
    destPath: String,
): LocalRecentEntry? {
    if (clientSourceId.isNotBlank()) {
        return list.firstOrNull { it.clientSourceId == clientSourceId }
    }
    if (kind.isBlank() || destPath.isBlank()) return null
    val candidates =
        list.filter { entry ->
            entry.kind == kind &&
                entry.destPath == destPath &&
                sourceDescriptorMatches(entry, preview)
        }
    return candidates.singleOrNull()
}

private fun sourceDescriptorMatches(entry: LocalRecentEntry, preview: String): Boolean {
    if (preview.isBlank()) return false
    return entry.preview == preview ||
        entry.title == preview ||
        entry.originalDisplayName == preview
}

data class OriginalSourceMetadata(
    val displayName: String = "",
    val size: Long = -1L,
    val mimeType: String = "",
)

/** Reject only a clear mismatch; missing provider metadata remains backward-compatible. */
fun originalSourceMetadataMatches(
    stored: OriginalSourceMetadata,
    current: OriginalSourceMetadata,
): Boolean {
    if (
        stored.mimeType.isNotBlank() &&
        current.mimeType.isNotBlank() &&
        !mimeTypesCompatible(stored.mimeType, current.mimeType)
    ) {
        return false
    }
    if (
        stored.displayName.isNotBlank() &&
        current.displayName.isNotBlank() &&
        stored.displayName != current.displayName
    ) {
        return false
    }
    if (stored.size > 0L && current.size > 0L && stored.size != current.size) {
        return false
    }
    return true
}

private fun mimeTypesCompatible(stored: String, current: String): Boolean {
    if (stored.equals(current, ignoreCase = true)) return true
    val s = stored.lowercase()
    val c = current.lowercase()
    if (s.endsWith("/*")) return c.startsWith(s.removeSuffix("*"))
    if (c.endsWith("/*")) return s.startsWith(c.removeSuffix("*"))
    return false
}
