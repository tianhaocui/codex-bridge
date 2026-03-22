package com.codexbridge.idea

interface BridgeWorker {
    fun send(
        message: String,
        cwd: String,
        resumeThreadId: String?,
        onDelta: (String) -> Unit,
        onDone: (Result<String>) -> Unit
    )

    fun interrupt()

    fun shutdown()
}
