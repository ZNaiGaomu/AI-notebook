package com.gaomu.suji.workshop

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.gaomu.suji.workshop.ui.navigation.SujiRoot
import com.gaomu.suji.workshop.ui.theme.SujiTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SujiTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SujiRoot()
                }
            }
        }
    }
}
