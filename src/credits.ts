/** Credits shown in the Credits panel (translations are listed per episode from the scenario data). */

export interface CreditItem {
  name: string;
  detail?: string;
  url?: string;
  license?: { label: string; url: string };
}

export interface CreditSection {
  title: string;
  items: CreditItem[];
}

export const APP_CREDITS: CreditSection[] = [
  {
    title: "Original work",
    items: [
      {
        name: "Link! Like! Love Live! — Hasunosora Girls' High School Idol Club",
        detail:
          "Story, characters, voice acting, music and 3D assets. ©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ",
        url: "https://www.lovelive-anime.jp/hasunosora/",
      },
    ],
  },
  {
    title: "Game asset data",
    items: [
      {
        name: "hamproductions — リンク！ライク！ラブライブ！ エクスプローラー",
        detail:
          "3D models, motions, expressions, backgrounds, voice clips, BGM and sound effects are loaded from the data this explorer publishes.",
        url: "https://hamproductions.github.io/llll/",
      },
    ],
  },
  {
    title: "Japanese word lookup",
    items: [
      {
        name: "JMdict",
        detail:
          "Electronic Dictionary Research and Development Group (EDRDG); JSON edition by scriptin/jmdict-simplified.",
        url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project",
        license: { label: "CC BY-SA 4.0", url: "https://www.edrdg.org/edrdg/licence.html" },
      },
      {
        name: "wordfreq — Robyn Speer",
        detail: "Word frequencies used to choose the most likely way to split each line into words.",
        url: "https://github.com/rspeer/wordfreq",
        license: { label: "CC BY-SA 4.0", url: "https://github.com/rspeer/wordfreq#license" },
      },
    ],
  },
  {
    title: "Resources & inspiration",
    items: [
      {
        name: "IntroToHasu",
        detail: "Watch order and index of fan translations.",
        url: "https://introtohasu.carrd.co/",
      },
      {
        name: "pjsk.cleista.cc",
        detail: "The Project SEKAI bilingual story reader this player's layout is modelled on.",
        url: "https://pjsk.cleista.cc/",
      },
    ],
  },
];

export const FAN_DISCLAIMER =
  "Unofficial fan project, not affiliated with or endorsed by the rights holders. All copyrights belong to their respective owners.";
