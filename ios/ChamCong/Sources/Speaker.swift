import AVFoundation

/// Reads Vietnamese sentences aloud. Uses the "playback" audio session so it is heard even with the
/// silent switch on.
final class Speaker {
    private let synth = AVSpeechSynthesizer()
    private lazy var voice = AVSpeechSynthesisVoice(language: "vi-VN")

    func speak(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        let u = AVSpeechUtterance(string: trimmed)
        u.voice = voice
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        synth.speak(u)
    }
}
