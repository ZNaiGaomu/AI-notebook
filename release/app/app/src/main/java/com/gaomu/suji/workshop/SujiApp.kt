package com.gaomu.suji.workshop

import android.app.Application
import com.gaomu.suji.workshop.data.prefs.SettingsRepository
import com.gaomu.suji.workshop.data.repo.QueueRepository
import com.gaomu.suji.workshop.net.BridgeClient

class SujiApp : Application() {
    lateinit var settings: SettingsRepository
        private set
    lateinit var bridge: BridgeClient
        private set
    lateinit var queue: QueueRepository
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = SettingsRepository(this)
        bridge = BridgeClient(settings)
        queue = QueueRepository(this)
    }

    companion object {
        lateinit var instance: SujiApp
            private set
    }
}
