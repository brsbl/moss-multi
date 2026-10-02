// ported-from: packages/desktop/src/renderer/editor/emoji-picker/emoji-data.ts @ 762abb777
/**
 * Curated emoji list for the ':' trigger typeahead.
 * ~150 common emojis with shortcodes and search keywords.
 * Kept inline to avoid adding an npm dependency.
 */

export interface EmojiEntry {
  emoji: string;
  shortcode: string;
  keywords: string[];
}

export const EMOJI_LIST: EmojiEntry[] = [
  // Smileys & People
  { emoji: '\u{1F600}', shortcode: 'grinning', keywords: ['smile', 'happy', 'face'] },
  { emoji: '\u{1F603}', shortcode: 'smiley', keywords: ['smile', 'happy', 'face'] },
  { emoji: '\u{1F604}', shortcode: 'smile', keywords: ['happy', 'face', 'grin'] },
  { emoji: '\u{1F601}', shortcode: 'grin', keywords: ['smile', 'happy'] },
  { emoji: '\u{1F606}', shortcode: 'laughing', keywords: ['smile', 'lol', 'haha'] },
  { emoji: '\u{1F605}', shortcode: 'sweat_smile', keywords: ['hot', 'happy'] },
  { emoji: '\u{1F602}', shortcode: 'joy', keywords: ['laugh', 'cry', 'tears', 'lol', 'haha'] },
  { emoji: '\u{1F923}', shortcode: 'rofl', keywords: ['laugh', 'lol', 'rolling'] },
  { emoji: '\u{1F60A}', shortcode: 'blush', keywords: ['smile', 'happy', 'shy'] },
  { emoji: '\u{1F607}', shortcode: 'innocent', keywords: ['angel', 'halo'] },
  { emoji: '\u{1F609}', shortcode: 'wink', keywords: ['face', 'flirt'] },
  { emoji: '\u{1F60C}', shortcode: 'relieved', keywords: ['relaxed', 'calm'] },
  { emoji: '\u{1F60D}', shortcode: 'heart_eyes', keywords: ['love', 'crush', 'adore'] },
  { emoji: '\u{1F618}', shortcode: 'kissing_heart', keywords: ['love', 'kiss', 'blow'] },
  { emoji: '\u{1F617}', shortcode: 'kissing', keywords: ['love', 'kiss'] },
  { emoji: '\u{1F61A}', shortcode: 'kissing_closed_eyes', keywords: ['love', 'kiss'] },
  { emoji: '\u{1F60B}', shortcode: 'yum', keywords: ['tongue', 'delicious', 'tasty'] },
  { emoji: '\u{1F61B}', shortcode: 'stuck_out_tongue', keywords: ['playful', 'silly'] },
  { emoji: '\u{1F61C}', shortcode: 'stuck_out_tongue_winking_eye', keywords: ['playful', 'silly', 'wink'] },
  { emoji: '\u{1F92A}', shortcode: 'zany_face', keywords: ['crazy', 'wild', 'silly'] },
  { emoji: '\u{1F911}', shortcode: 'money_mouth', keywords: ['rich', 'dollar'] },
  { emoji: '\u{1F917}', shortcode: 'hugs', keywords: ['hug', 'embrace'] },
  { emoji: '\u{1F914}', shortcode: 'thinking', keywords: ['hmm', 'consider', 'ponder'] },
  { emoji: '\u{1F910}', shortcode: 'zipper_mouth', keywords: ['quiet', 'secret', 'shh'] },
  { emoji: '\u{1F928}', shortcode: 'raised_eyebrow', keywords: ['skeptical', 'doubt'] },
  { emoji: '\u{1F610}', shortcode: 'neutral_face', keywords: ['meh', 'blank'] },
  { emoji: '\u{1F611}', shortcode: 'expressionless', keywords: ['blank', 'deadpan'] },
  { emoji: '\u{1F636}', shortcode: 'no_mouth', keywords: ['silence', 'speechless'] },
  { emoji: '\u{1F60F}', shortcode: 'smirk', keywords: ['smug', 'sly'] },
  { emoji: '\u{1F612}', shortcode: 'unamused', keywords: ['annoyed', 'side_eye'] },
  { emoji: '\u{1F644}', shortcode: 'roll_eyes', keywords: ['annoyed', 'whatever'] },
  { emoji: '\u{1F62C}', shortcode: 'grimacing', keywords: ['awkward', 'nervous'] },
  { emoji: '\u{1F925}', shortcode: 'lying_face', keywords: ['pinocchio', 'liar'] },
  { emoji: '\u{1F60E}', shortcode: 'sunglasses', keywords: ['cool', 'boss'] },
  { emoji: '\u{1F913}', shortcode: 'nerd', keywords: ['geek', 'glasses'] },
  { emoji: '\u{1F615}', shortcode: 'confused', keywords: ['puzzled'] },
  { emoji: '\u{1F61F}', shortcode: 'worried', keywords: ['concern', 'anxious'] },
  { emoji: '\u{1F641}', shortcode: 'slightly_frowning_face', keywords: ['sad', 'disappointed'] },
  { emoji: '\u{1F62E}', shortcode: 'open_mouth', keywords: ['surprised', 'shock', 'wow'] },
  { emoji: '\u{1F632}', shortcode: 'astonished', keywords: ['surprised', 'shocked'] },
  { emoji: '\u{1F633}', shortcode: 'flushed', keywords: ['embarrassed', 'red'] },
  { emoji: '\u{1F631}', shortcode: 'scream', keywords: ['fear', 'horror', 'scared'] },
  { emoji: '\u{1F628}', shortcode: 'fearful', keywords: ['scared', 'afraid'] },
  { emoji: '\u{1F630}', shortcode: 'cold_sweat', keywords: ['anxious', 'nervous'] },
  { emoji: '\u{1F622}', shortcode: 'cry', keywords: ['sad', 'tear'] },
  { emoji: '\u{1F62D}', shortcode: 'sob', keywords: ['cry', 'sad', 'bawl'] },
  { emoji: '\u{1F624}', shortcode: 'triumph', keywords: ['steam', 'frustrated'] },
  { emoji: '\u{1F620}', shortcode: 'angry', keywords: ['mad', 'rage'] },
  { emoji: '\u{1F621}', shortcode: 'rage', keywords: ['angry', 'furious'] },
  { emoji: '\u{1F92C}', shortcode: 'cursing', keywords: ['angry', 'swear'] },
  { emoji: '\u{1F608}', shortcode: 'smiling_imp', keywords: ['devil', 'evil'] },
  { emoji: '\u{1F4A9}', shortcode: 'poop', keywords: ['poo', 'crap'] },
  { emoji: '\u{1F921}', shortcode: 'clown', keywords: ['joker', 'funny'] },
  { emoji: '\u{1F480}', shortcode: 'skull', keywords: ['dead', 'death', 'rip'] },
  { emoji: '\u{1F47B}', shortcode: 'ghost', keywords: ['spooky', 'halloween'] },
  { emoji: '\u{1F916}', shortcode: 'robot', keywords: ['bot', 'machine', 'ai'] },
  { emoji: '\u{1F44D}', shortcode: 'thumbsup', keywords: ['approve', 'ok', 'like', 'yes', '+1'] },
  { emoji: '\u{1F44E}', shortcode: 'thumbsdown', keywords: ['disapprove', 'dislike', 'no', '-1'] },
  { emoji: '\u{1F44F}', shortcode: 'clap', keywords: ['applause', 'bravo'] },
  { emoji: '\u{1F64C}', shortcode: 'raised_hands', keywords: ['celebrate', 'hooray', 'praise'] },
  { emoji: '\u{1F64F}', shortcode: 'pray', keywords: ['please', 'thanks', 'hope', 'namaste'] },
  { emoji: '\u{1F91D}', shortcode: 'handshake', keywords: ['deal', 'agree'] },
  { emoji: '\u270C\uFE0F', shortcode: 'v', keywords: ['peace', 'victory'] },
  { emoji: '\u{1F44B}', shortcode: 'wave', keywords: ['hello', 'hi', 'bye'] },
  { emoji: '\u{1F44C}', shortcode: 'ok_hand', keywords: ['perfect', 'fine'] },
  { emoji: '\u{1F4AA}', shortcode: 'muscle', keywords: ['strong', 'flex', 'bicep'] },
  { emoji: '\u270D\uFE0F', shortcode: 'writing_hand', keywords: ['write', 'compose'] },

  // Hearts & Symbols
  { emoji: '\u2764\uFE0F', shortcode: 'heart', keywords: ['love', 'red'] },
  { emoji: '\u{1F9E1}', shortcode: 'orange_heart', keywords: ['love'] },
  { emoji: '\u{1F49B}', shortcode: 'yellow_heart', keywords: ['love'] },
  { emoji: '\u{1F49A}', shortcode: 'green_heart', keywords: ['love'] },
  { emoji: '\u{1F499}', shortcode: 'blue_heart', keywords: ['love'] },
  { emoji: '\u{1F49C}', shortcode: 'purple_heart', keywords: ['love'] },
  { emoji: '\u{1F494}', shortcode: 'broken_heart', keywords: ['sad', 'heartbreak'] },
  { emoji: '\u{1F525}', shortcode: 'fire', keywords: ['hot', 'flame', 'lit'] },
  { emoji: '\u2B50', shortcode: 'star', keywords: ['gold', 'favorite'] },
  { emoji: '\u{1F31F}', shortcode: 'star2', keywords: ['sparkle', 'glowing'] },
  { emoji: '\u26A1', shortcode: 'zap', keywords: ['lightning', 'electric', 'thunder'] },
  { emoji: '\u{1F4A5}', shortcode: 'boom', keywords: ['explosion', 'collision'] },
  { emoji: '\u2728', shortcode: 'sparkles', keywords: ['magic', 'clean', 'new'] },
  { emoji: '\u{1F389}', shortcode: 'tada', keywords: ['party', 'celebrate', 'congrats'] },
  { emoji: '\u{1F388}', shortcode: 'balloon', keywords: ['party', 'birthday'] },
  { emoji: '\u{1F381}', shortcode: 'gift', keywords: ['present', 'birthday'] },
  { emoji: '\u{1F3C6}', shortcode: 'trophy', keywords: ['win', 'award', 'champion'] },
  { emoji: '\u{1F3AF}', shortcode: 'dart', keywords: ['target', 'bullseye', 'goal'] },
  { emoji: '\u{1F48E}', shortcode: 'gem', keywords: ['diamond', 'jewel', 'precious'] },

  // Nature & Weather
  { emoji: '\u2600\uFE0F', shortcode: 'sunny', keywords: ['sun', 'weather', 'bright'] },
  { emoji: '\u{1F324}\uFE0F', shortcode: 'sun_small_cloud', keywords: ['weather', 'partly'] },
  { emoji: '\u2601\uFE0F', shortcode: 'cloud', keywords: ['weather', 'overcast'] },
  { emoji: '\u{1F327}\uFE0F', shortcode: 'rain_cloud', keywords: ['weather', 'rainy'] },
  { emoji: '\u{1F308}', shortcode: 'rainbow', keywords: ['weather', 'colorful'] },
  { emoji: '\u2744\uFE0F', shortcode: 'snowflake', keywords: ['winter', 'cold', 'ice'] },
  { emoji: '\u{1F332}', shortcode: 'evergreen_tree', keywords: ['nature', 'pine'] },
  { emoji: '\u{1F33B}', shortcode: 'sunflower', keywords: ['nature', 'flower'] },
  { emoji: '\u{1F337}', shortcode: 'tulip', keywords: ['nature', 'flower'] },
  { emoji: '\u{1F339}', shortcode: 'rose', keywords: ['nature', 'flower', 'love'] },
  { emoji: '\u{1F33F}', shortcode: 'herb', keywords: ['nature', 'plant', 'green'] },
  { emoji: '\u{1F340}', shortcode: 'four_leaf_clover', keywords: ['lucky', 'nature'] },
  { emoji: '\u{1F341}', shortcode: 'maple_leaf', keywords: ['fall', 'autumn', 'nature'] },

  // Animals
  { emoji: '\u{1F436}', shortcode: 'dog', keywords: ['puppy', 'pet', 'animal'] },
  { emoji: '\u{1F431}', shortcode: 'cat', keywords: ['kitten', 'pet', 'animal'] },
  { emoji: '\u{1F42D}', shortcode: 'mouse', keywords: ['animal', 'rodent'] },
  { emoji: '\u{1F43B}', shortcode: 'bear', keywords: ['animal'] },
  { emoji: '\u{1F98A}', shortcode: 'fox', keywords: ['animal', 'clever'] },
  { emoji: '\u{1F427}', shortcode: 'penguin', keywords: ['animal', 'cold'] },
  { emoji: '\u{1F41D}', shortcode: 'bee', keywords: ['insect', 'honey', 'buzz'] },
  { emoji: '\u{1F98B}', shortcode: 'butterfly', keywords: ['insect', 'pretty'] },
  { emoji: '\u{1F422}', shortcode: 'turtle', keywords: ['animal', 'slow'] },
  { emoji: '\u{1F419}', shortcode: 'octopus', keywords: ['animal', 'tentacle'] },

  // Food & Drink
  { emoji: '\u{1F34E}', shortcode: 'apple', keywords: ['fruit', 'red'] },
  { emoji: '\u{1F34A}', shortcode: 'tangerine', keywords: ['fruit', 'orange'] },
  { emoji: '\u{1F353}', shortcode: 'strawberry', keywords: ['fruit', 'berry'] },
  { emoji: '\u{1F349}', shortcode: 'watermelon', keywords: ['fruit', 'summer'] },
  { emoji: '\u{1F355}', shortcode: 'pizza', keywords: ['food', 'slice'] },
  { emoji: '\u{1F354}', shortcode: 'hamburger', keywords: ['food', 'burger'] },
  { emoji: '\u{1F382}', shortcode: 'birthday', keywords: ['cake', 'celebration'] },
  { emoji: '\u2615', shortcode: 'coffee', keywords: ['drink', 'cafe', 'tea', 'morning'] },
  { emoji: '\u{1F37B}', shortcode: 'beers', keywords: ['drink', 'cheers', 'alcohol'] },
  { emoji: '\u{1F377}', shortcode: 'wine_glass', keywords: ['drink', 'alcohol'] },

  // Objects & Tools
  { emoji: '\u{1F4A1}', shortcode: 'bulb', keywords: ['idea', 'light', 'lamp'] },
  { emoji: '\u{1F4D6}', shortcode: 'book', keywords: ['read', 'open'] },
  { emoji: '\u{1F4DA}', shortcode: 'books', keywords: ['read', 'library', 'study'] },
  { emoji: '\u{1F4DD}', shortcode: 'memo', keywords: ['note', 'write', 'document'] },
  { emoji: '\u{1F4CB}', shortcode: 'clipboard', keywords: ['copy', 'paste', 'list'] },
  { emoji: '\u{1F4CC}', shortcode: 'pushpin', keywords: ['pin', 'mark'] },
  { emoji: '\u{1F4CE}', shortcode: 'paperclip', keywords: ['attach', 'attachment'] },
  { emoji: '\u{1F4E7}', shortcode: 'email', keywords: ['mail', 'envelope'] },
  { emoji: '\u{1F4F1}', shortcode: 'iphone', keywords: ['phone', 'mobile'] },
  { emoji: '\u{1F4BB}', shortcode: 'computer', keywords: ['laptop', 'mac'] },
  { emoji: '\u{1F5C2}\uFE0F', shortcode: 'card_index_dividers', keywords: ['folder', 'organize'] },
  { emoji: '\u{1F512}', shortcode: 'lock', keywords: ['secure', 'private'] },
  { emoji: '\u{1F513}', shortcode: 'unlock', keywords: ['open', 'access'] },
  { emoji: '\u{1F528}', shortcode: 'hammer', keywords: ['tool', 'build'] },
  { emoji: '\u{1F527}', shortcode: 'wrench', keywords: ['tool', 'fix', 'settings'] },
  { emoji: '\u2699\uFE0F', shortcode: 'gear', keywords: ['settings', 'config', 'cog'] },
  { emoji: '\u{1F50D}', shortcode: 'mag', keywords: ['search', 'zoom', 'find'] },
  { emoji: '\u{1F3B5}', shortcode: 'musical_note', keywords: ['music', 'song'] },
  { emoji: '\u{1F3A8}', shortcode: 'art', keywords: ['paint', 'palette', 'creative'] },
  { emoji: '\u{1F4F8}', shortcode: 'camera_flash', keywords: ['photo', 'picture'] },
  { emoji: '\u{1F570}\uFE0F', shortcode: 'mantelpiece_clock', keywords: ['time', 'clock'] },

  // Arrows & Indicators
  { emoji: '\u2705', shortcode: 'white_check_mark', keywords: ['check', 'done', 'yes', 'complete'] },
  { emoji: '\u274C', shortcode: 'x', keywords: ['no', 'cross', 'wrong', 'delete'] },
  { emoji: '\u2757', shortcode: 'exclamation', keywords: ['important', 'alert', 'warning'] },
  { emoji: '\u2753', shortcode: 'question', keywords: ['what', 'confused', 'help'] },
  { emoji: '\u{1F6A8}', shortcode: 'rotating_light', keywords: ['alert', 'warning', 'emergency'] },
  { emoji: '\u{1F6AB}', shortcode: 'no_entry_sign', keywords: ['forbidden', 'stop', 'blocked'] },
  { emoji: '\u27A1\uFE0F', shortcode: 'arrow_right', keywords: ['direction', 'next'] },
  { emoji: '\u2B05\uFE0F', shortcode: 'arrow_left', keywords: ['direction', 'back'] },
  { emoji: '\u2B06\uFE0F', shortcode: 'arrow_up', keywords: ['direction', 'top'] },
  { emoji: '\u2B07\uFE0F', shortcode: 'arrow_down', keywords: ['direction', 'bottom'] },
  { emoji: '\u{1F504}', shortcode: 'arrows_counterclockwise', keywords: ['refresh', 'reload', 'sync'] },
  { emoji: '\u267B\uFE0F', shortcode: 'recycle', keywords: ['environment', 'green'] },
  { emoji: '\u{1F4AC}', shortcode: 'speech_balloon', keywords: ['comment', 'chat', 'talk', 'message'] },
  { emoji: '\u{1F4AD}', shortcode: 'thought_balloon', keywords: ['think', 'idea'] },
  { emoji: '\u{1F6A7}', shortcode: 'construction', keywords: ['wip', 'warning', 'build'] },
  { emoji: '\u{1F3E0}', shortcode: 'house', keywords: ['home'] },
  { emoji: '\u{1F680}', shortcode: 'rocket', keywords: ['launch', 'fast', 'ship', 'space'] },
  { emoji: '\u{1F6E1}\uFE0F', shortcode: 'shield', keywords: ['protect', 'security', 'safety'] },
  { emoji: '\u{1F3F3}\uFE0F', shortcode: 'white_flag', keywords: ['surrender', 'peace'] },
  { emoji: '\u{1F3C1}', shortcode: 'checkered_flag', keywords: ['finish', 'race', 'done'] },
];

/**
 * Filter emojis by matching query against shortcode and keywords.
 * Returns up to maxResults matches.
 */
export function filterEmojis(query: string, maxResults = 50): EmojiEntry[] {
  if (!query) {
    return EMOJI_LIST.slice(0, maxResults);
  }

  const lowerQuery = query.toLowerCase();

  return EMOJI_LIST.filter((entry) => {
    if (entry.shortcode.includes(lowerQuery)) return true;
    return entry.keywords.some((kw) => kw.includes(lowerQuery));
  }).slice(0, maxResults);
}
