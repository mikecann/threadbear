import SwiftUI
import ThreadbearCore

/// Settings > Voice & Audio: this Mac's own choices for Voice mode
/// (VoiceMode) and the ding when a thread finishes (DingPlayer), kept in
/// UserDefaults rather than the runner, as the microphone and the speaker
/// are this Mac's.
struct VoiceSettings: View {
    @AppStorage(VoiceCatalog.voiceKey) private var voiceId = VoiceCatalog.defaultVoice.id
    @AppStorage(VoiceCatalog.speedKey) private var speed = 1.0
    @AppStorage(VoiceCatalog.languageKey) private var language = "english"
    @AppStorage(VoiceCatalog.microphoneKey) private var microphone = ""
    @AppStorage(VoiceMode.enabledKey) private var enabled = true
    @AppStorage(NoteDictation.enabledKey) private var inNotes = false
    @AppStorage(VoiceIcon.key) private var icon = VoiceIcon.fallback.rawValue
    @AppStorage(VoiceKeys.commandModeKey) private var commandMode = false
    @AppStorage(VoiceKeys.triggerKey) private var trigger = VoiceTriggerKey.fn.rawValue
    @State private var microphones: [VoiceAudio.Microphone] = []
    @State private var voice = VoiceMode.shared
    @AppStorage(CompletionSound.enabledKey) private var dingOn = false
    @AppStorage(CompletionSound.dingKey) private var ding = CompletionSound.Ding.chime.rawValue
    @AppStorage(CompletionSound.volumeKey) private var dingVolume = CompletionSound.defaultVolume

    var body: some View {
        Form {
            SettingsSection("Voice",
                            about: "Press the microphone button beside Send to talk with a thread out loud. What you say goes to the thread as your message, even while it's working, and its replies are read out. Talk over it and it stops to listen. It's the same thread, with the same memory, tools and approvals. Use with Notes adds a microphone to Notes, so you can talk and have it typed into the note. With Voice on, hold Fn anywhere in Threadbear to dictate into the text box you're in (Settings > Keyboard changes the keys). Speech is turned into text on this Mac by macOS, and replies are spoken by Kyutai's pocket-tts, which Threadbear downloads the first time you use Voice.",
                            ask: "change how Voice sounds, or check on it if it isn't working.") {
                Toggle("Use Voice", isOn: $enabled)
                    .tip("Show the microphone button beside Send to talk with threads out loud, and turn on Voice's keyboard shortcuts")
                    .onChange(of: enabled) { _, on in if !on { VoiceMode.shared.stop(); NoteDictation.shared.stop(); KeyDictation.shared.cancel() } }
                Toggle("Use with Notes", isOn: $inNotes)
                    .disabled(!enabled)
                    .tip("Show a microphone button in Notes, to talk and have what you say typed into the note on this Mac")
                    .onChange(of: inNotes) { _, on in if !on { NoteDictation.shared.stop() } }
                Picker("Button icon", selection: $icon) {
                    ForEach(VoiceIcon.allCases) { choice in
                        Label { Text(choice.title) } icon: { Image(nsImage: choice.image(side: 14)).renderingMode(.template) }
                            .tag(choice.rawValue)
                    }
                }
                .disabled(!enabled)
                .tip("The icon on the Voice button beside Send and in Notes")
                Toggle("Command Mode", isOn: $commandMode)
                    .disabled(!enabled)
                    .tip("Hold \(VoiceKeys(defaults: .standard).commandDisplay) and talk: when you let go, what you said goes to the open thread as your message")
                    .onChange(of: commandMode) { _, on in if !on, KeyDictation.shared.mode == .command { KeyDictation.shared.cancel() } }
                if enabled, trigger == VoiceTriggerKey.fn.rawValue, Self.fnKeyTakenByMacOS {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("macOS also uses Fn, so a tap or double tap can open emoji. To use it for Voice alone, set Press 🌐 key to Do Nothing in System Settings > Keyboard.")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Button("Open Keyboard Settings") {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")!)
                        }
                        .controlSize(.small)
                        .tip("Open System Settings > Keyboard, where Press 🌐 key to is")
                    }
                }
                Picker("Voice", selection: $voiceId) {
                    ForEach(VoiceCatalog.voices) { Text($0.name).tag($0.id) }
                }
                .tip("Who the agent sounds like")
                Picker("Speed", selection: $speed) {
                    ForEach(VoiceCatalog.speeds, id: \.self) { Text(VoiceCatalog.speedTitle($0)).tag($0) }
                }
                .tip("How fast replies are read")
                Picker("Language", selection: $language) {
                    ForEach(VoiceCatalog.languages) { Text($0.name).tag($0.id) }
                }
                .tip("The language you speak and replies are read in")
                LabeledContent("Try it") {
                    HStack(spacing: 8) {
                        if let status = voice.previewStatus {
                            Text(status).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Button("Play a Sample") {
                            voice.preview(voice: VoiceCatalog.voice(voiceId), speed: VoiceCatalog.speed(speed))
                        }
                        .tip("Hear this voice at this speed")
                    }
                }
            }

            SettingsSection("Sounds",
                            about: "A soft ding when a thread finishes working: its reply is done, it's waiting for your answer, or it hit an error. It plays wherever you are, even in another app, and stays quiet for a thread you stopped yourself or one you're talking with in Voice.",
                            ask: "change when the ding plays.") {
                Toggle("Play a sound when a thread finishes", isOn: $dingOn)
                    .tip("A soft ding when a thread is done and ready for you")
                    .onChange(of: dingOn) { _, on in if on { DingPlayer.play() } }
                Picker("Sound", selection: $ding) {
                    ForEach(CompletionSound.Ding.allCases) { Text($0.title).tag($0.rawValue) }
                }
                .tip("Which ding plays")
                .onChange(of: ding) { _, new in DingPlayer.play(CompletionSound.ding(new)) }
                LabeledContent("Volume") {
                    HStack(spacing: 8) {
                        Slider(value: $dingVolume, in: 0.1...1) { editing in if !editing { DingPlayer.play() } }
                            .frame(maxWidth: 180)
                            .tip("How loud the ding is")
                        Button("Play") { DingPlayer.play() }
                            .tip("Hear the ding")
                    }
                }
            }

            SettingsSection("System",
                            about: "The microphone Voice listens on. System Default follows System Settings > Sound.",
                            ask: "find out why it can't hear you.") {
                Picker("Microphone", selection: $microphone) {
                    Text("System Default").tag("")
                    ForEach(microphones) { Text($0.name).tag($0.uid) }
                }
                .tip("The microphone Voice listens on")
            }
        }
        .formStyle(.grouped)
        .fixedSize(horizontal: false, vertical: true)
        .scrollIndicators(.never)
        .scrollDisabled(true)
        .onAppear { microphones = VoiceAudio.microphones() }
    }

    /// System Settings > Keyboard > Press 🌐 key to, anything but Do Nothing
    /// (0): then macOS opens emoji or its own dictation on Fn as well.
    static var fnKeyTakenByMacOS: Bool {
        (UserDefaults(suiteName: "com.apple.HIToolbox")?.object(forKey: "AppleFnUsageType") as? Int) != 0
    }
}
