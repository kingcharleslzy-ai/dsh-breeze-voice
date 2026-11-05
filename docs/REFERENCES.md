# Design and integration references

Reviewed 2026-11-02 for the voice workbench update. These projects were inspected as references; none was installed into the user's DSH and their implementations were not copied into this plugin.

- [OldQin-Aurora001/dsh-breeze-tts](https://github.com/OldQin-Aurora001/dsh-breeze-tts): separate voice use and voice creation/management, audition before selection. Its voice-library API targets a different backend. This plugin generates and stores a reference clip once on the deployed official PyTorch backend, then reuses that reference for every spoken sentence. The workbench separates the fixed server voice library from editable description drafts, and auditions the selected fixed voice before applying settings.
- [maoyuching/dsh-voice-chat](https://github.com/maoyuching/dsh-voice-chat): explicit conversational settings, endpointing and separate speech output behavior.
- [Awoodwhale/dsh-agent-persona](https://github.com/Awoodwhale/dsh-agent-persona): session-scoped persona management and native prompt assembly. The voice plugin scopes its persona/default voice prompt to an active call lease, with expiry and explicit stop cleanup.
- The user's existing Qwen Studio source supplied the native `sidebar.panellist` and `main` slot pattern so voice settings have the same first-class navigation entry as image settings.

Voice instruction controls acoustic style; voice-mode prompt controls the language model's spoken response style; persona prompt describes the conversational role. They have separate controls and are not interchangeable.
