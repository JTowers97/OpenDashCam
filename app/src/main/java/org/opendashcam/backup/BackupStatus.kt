package org.opendashcam.backup

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Live backup progress for the UI. */
object BackupStatus {
    data class State(
        val running: Boolean = false,
        val currentClip: String? = null,
        val progress: Float = 0f,
        val pending: Int = 0,
        val message: String? = null,
        val error: Boolean = false,
        val lastSuccessAt: Long = 0,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun update(transform: State.() -> State) {
        _state.value = _state.value.transform()
    }
}
