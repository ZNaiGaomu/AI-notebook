package com.gaomu.suji.workshop.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Bg = Color(0xFF0F1115)
val Card = Color(0xFF1A1D24)
val TextPrimary = Color(0xFFE8EAED)
val Muted = Color(0xFF9AA0A6)
val Accent = Color(0xFF7C9CFF)
val Ok = Color(0xFF3DD68C)
val Danger = Color(0xFFFF6B6B)
val Border = Color(0xFF2A2F3A)
val Warn = Color(0xFFFFCC80)
val SecondaryBtn = Color(0xFF2A3142)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF0B1020),
    secondary = SecondaryBtn,
    onSecondary = TextPrimary,
    background = Bg,
    onBackground = TextPrimary,
    surface = Card,
    onSurface = TextPrimary,
    error = Danger,
    onError = TextPrimary,
    outline = Border,
)

@Composable
fun SujiTheme(content: @Composable () -> Unit) {
    // Always dark for capture comfort (v1 ignores system light theme).
    @Suppress("UNUSED_VARIABLE")
    val systemDark = isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = DarkColors,
        content = content,
    )
}
