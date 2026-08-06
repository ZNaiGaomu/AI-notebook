package com.gaomu.suji.workshop.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.gaomu.suji.workshop.util.BridgeLink
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore("suji_settings")

enum class AudioFormat(val mimeType: String, val fileExt: String, val label: String) {
    M4A("audio/mp4", "m4a", "M4A（默认，体积小）"),
    WAV("audio/wav", "wav", "WAV（兼容优先）"),
}

data class AppSettings(
    val baseUrl: String = "",
    val token: String = "",
    val audioFormat: AudioFormat = AudioFormat.M4A,
    val lastNotebookId: String = "",
    val lastItemId: String = "",
    /** 0 = permanent. >0 move queue items older than N days into trash. */
    val queueRetentionDays: Int = 0,
) {
    val isConfigured: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()
}

class SettingsRepository(private val context: Context) {
    private val keyBase = stringPreferencesKey("base_url")
    private val keyToken = stringPreferencesKey("token")
    private val keyAudio = stringPreferencesKey("audio_format")
    private val keyNb = stringPreferencesKey("last_notebook_id")
    private val keyItem = stringPreferencesKey("last_item_id")
    private val keyRetention = intPreferencesKey("queue_retention_days")

    val settingsFlow: Flow<AppSettings> =
        context.dataStore.data.map { p ->
            AppSettings(
                baseUrl = p[keyBase].orEmpty(),
                token = p[keyToken].orEmpty(),
                audioFormat =
                    runCatching { AudioFormat.valueOf(p[keyAudio] ?: AudioFormat.M4A.name) }
                        .getOrDefault(AudioFormat.M4A),
                lastNotebookId = p[keyNb].orEmpty(),
                lastItemId = p[keyItem].orEmpty(),
                queueRetentionDays = p[keyRetention] ?: 0,
            )
        }

    suspend fun saveLink(link: BridgeLink) {
        context.dataStore.edit { p ->
            p[keyBase] = link.baseUrl.trimEnd('/')
            p[keyToken] = link.token
        }
    }

    suspend fun saveParts(baseUrl: String, token: String) {
        context.dataStore.edit { p ->
            p[keyBase] = baseUrl.trimEnd('/')
            p[keyToken] = token.trim()
        }
    }

    suspend fun setAudioFormat(format: AudioFormat) {
        context.dataStore.edit { p -> p[keyAudio] = format.name }
    }

    suspend fun setQueueRetentionDays(days: Int) {
        context.dataStore.edit { p -> p[keyRetention] = days.coerceAtLeast(0) }
    }

    suspend fun setLastTarget(notebookId: String, itemId: String) {
        context.dataStore.edit { p ->
            p[keyNb] = notebookId
            p[keyItem] = itemId
        }
    }
}
