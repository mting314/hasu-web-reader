import { AudioMixer as AudioMixerClass } from "./engine/AudioMixer";

export const AudioMixer = new AudioMixerClass();

// When Vite hot-reloads this module a new mixer is created; stop the old one's audio so
// sounds from the previous instance can't keep playing with nothing able to stop them.
if (import.meta.hot) {
  import.meta.hot.dispose(() => AudioMixer.dispose());
}
