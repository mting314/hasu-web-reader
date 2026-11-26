/**
 * public/data/story_index.json, written by scripts/build_story_index.py from the game's
 * AdvSeries / AdvDatas master tables (the data behind its 活動記録 screen).
 */

export interface StoryIndexPart {
  /** game script id, e.g. "10300101" (story_main_<id>.txt) */
  scriptId: string;
  /** reader slug, e.g. "103-ep1-part1" */
  slug: string;
  /** the game's part label: "PART 1", or a title (102期 Shades of Stars) */
  label: string;
  /** the game's part number text: "1" / "第1話" */
  number: string;
  /** part thumbnail (828x238), or the game's placeholder */
  thumbnail: string | null;
  /** compiled into public/data/scenarios, so the reader can play it */
  available: boolean;
  titleEn: string | null;
}

export interface StoryIndexSeries {
  /** AdvSeries id, e.g. 103001 (103期 episode 1); 2000xx are the special chapters */
  id: number;
  /** 0 = main story (year / month carousel), 1 = chapters */
  segment: number;
  fiscalYear: number;
  /** "103期" */
  yearText: string;
  /** "April", "Spring", "Chapter PERENNIAL" */
  monthText: string;
  title: string;
  description: string;
  titleEn: string | null;
  descriptionEn: string | null;
  card: string | null;
  /** monthly cards are portrait renders; chapter cards are wide illustrations */
  cardShape: "portrait" | "wide";
  parts: StoryIndexPart[];
}

export interface StoryIndex {
  source: Record<string, string>;
  segments: { id: number; label: string }[];
  years: { fiscalYear: number; yearText: string }[];
  series: StoryIndexSeries[];
}
