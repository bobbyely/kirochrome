// Generates packages/web/src/games/words.ts from the system dictionary.
//
// The games need two things a bundle should not carry in full: a validity
// check for guesses and, for the anagram game, every word hiding in each
// puzzle. Both are cut down here so the shipped file stays small — the whole
// dictionary is 235k words; what ships is the 5-letter slice for Wordle and
// the sub-anagrams of the curated puzzle words.
//
// Two word sources, used for different jobs. The system dictionary is
// Webster's 1934 list: huge, so a lenient check for Wordle guesses, but full
// of words nobody would guess ("abaff"), so no good for anything shown to the
// player. scripts/common-words.txt is a frequency-derived list of ordinary
// words, and is what an anagram's "found 5 of 23" counts against.
//
// Answers and puzzles are hand-picked below so they are guessable.
//
// Usage: node scripts/words.mjs

import { readFileSync, writeFileSync } from "node:fs";

const DICT = "/usr/share/dict/words";
const COMMON = new URL("./common-words.txt", import.meta.url);
const OUT = new URL("../packages/web/src/games/words.ts", import.meta.url);

const readWords = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((w) => /^[a-z]{3,7}$/.test(w));
const dict = new Set(readWords(DICT));
const common = new Set(readWords(COMMON));

// Wordle answers: common words with no plurals-by-s, chosen to be guessable.
const ANSWERS = `
about above abuse actor acute admit adopt adult after again agent agree ahead alarm album alert alike alive allow alone along alter among angel anger angle angry apart apple apply arena argue arise armor array arrow aside asset audio audit avoid awake award aware awful
bacon badge badly baker basic basin batch beach beard beast began begin begun being belly below bench berry birth black blade blame blank blast blaze bleed blend bless blind block blood bloom blown board boost booth bound brain brand brass brave bread break breed brick bride brief bring broad broke brown brush build built bunch burst buyer
cabin cable camel candy cargo carry carve catch cause chain chair chalk champ chaos charm chart chase cheap check cheek cheer chess chest chief child chill china choir chose chunk civic civil claim clash class clean clear clerk click cliff climb clock close cloth cloud coach coast could count court cover crack craft crane crash crazy cream creek crime crisp cross crowd crown crude cruel crush curve cycle
daily dairy dance dated dealt death debut decay delay delta dense depth derby devil diary dirty ditch dodge doing doubt dough dozen draft drain drama drank drawn dream dress dried drift drill drink drive drove drown dwarf dying
eager eagle early earth eight elbow elder elect elite empty enemy enjoy enter entry equal error essay event every exact exist extra
faint fairy faith false fancy fatal fault favor feast fence ferry fever fiber field fifth fifty fight final first fixed flame flash fleet flesh float flock flood floor flour fluid flush focus force forge forth forum found frame frank fraud fresh front frost fruit fully funny
ghost giant given glass globe glory glove going grace grade grain grand grant grape graph grasp grass grave great greed green greet grief grill grind gross group grown guard guess guest guide guilt
habit happy harsh haste haven heard heart heavy hedge hello hence hobby honey honor horse hotel house human humor hurry
ideal image imply index inner input irony issue
jelly jewel joint judge juice
kneel knife knock known
label labor large laser later laugh layer learn lease least leave legal lemon level lever light limit linen liver lobby local lodge logic loose lover lower loyal lucky lunar lunch lying
magic major maker maple march match mayor meant medal media mercy merit metal meter midst might minor minus mixed model moist money month moral motor mount mouse mouth movie music
naive nasty naval nerve never newly night noble noise north notch novel nurse
occur ocean offer often olive onion onset opera orbit order organ other ought outer owner
paint panel panic paper party pasta patch pause peace pearl penny phase phone photo piano piece pilot pinch pitch pixel place plain plane plant plate plaza plead pluck point polar porch pound power press price pride prime print prior prize probe proof proud prove proxy pulse punch pupil purse
queen query quest quick quiet quilt quite quota quote
radar radio raise rally ranch range rapid ratio reach react ready realm rebel refer reign relax relay renew reply rider ridge rifle right rigid risky rival river roast robot rocky rough round route royal rugby ruler rural
salad sauce scale scare scene scent scope score scout scrap screw seize sense serve seven shade shaft shake shall shame shape share shark sharp sheep sheer sheet shelf shell shift shine shirt shock shoot shore short shout shown sight silly since sixth skill skirt slate sleep slice slide slope small smart smell smile smoke snake sneak solar solid solve sorry sound south space spare spark speak speed spell spend spice spike spine spite split spoke spoon sport spray squad stack staff stage stain stair stake stamp stand stare start state steak steal steam steel steep steer stern stick stiff still sting stock stone stood stool store storm story stout stove strap straw strip stuck study stuff style sugar suite sunny super sweet swept swift swing sword
table taken taste teach tempo tenth thank theft their theme there these thick thief thing think third those three threw throw thumb tiger tight timer title toast today token topic torch total touch tough tower toxic trace track trade trail train trait trash treat trend trial tribe trick tried troop truck truly trunk trust truth twice
uncle under union unite until upper upset urban usage usual utter
vague valid value vapor vault venue verse video villa vinyl viral virus visit vital vivid vocal voice voter
wagon waist waste watch water weary weigh weird whale wheat wheel where which while white whole whose widow width witch woman world worry worse worst worth would wound wrist write wrong wrote
yacht yield young youth
`.trim().split(/\s+/);

// Anagram puzzles: seven-letter words with at least eight common words inside.
// Drop any the generator reports below that.
const PUZZLES = `
almonds animals balance baskets battery blanket bracket branded breathe brother cabinet capture careful catches central certain chapter charter chicken climate closest concert contest country courage created culture dealing deposit dessert details drawing endless engines example farming feature flowers freedom gardens general glasses harvest healthy history holiday honesty imagine insects instead island lantern leading leather lessons letters machine married masters meaning message minutes monster nothing numbers outside painted parents partner patient perfect picture planets plastic players present printer private problem protect quarter reading records related respect sailors science seasons setting shelter sisters soldier speaker special station stories strange streams student surface teacher theatre trained treated trouble variety village warning weather western whisper winters writers
`.trim().split(/\s+/);

// A curated word in neither list is listed so a typo is visible, then kept.
const missing = [...ANSWERS, ...PUZZLES].filter((w) => !dict.has(w) && !common.has(w));
if (missing.length) console.warn(`Not in either word list (kept): ${missing.join(" ")}`);
for (const w of missing) common.add(w);

const letters = (w) => [...w].sort().join("");

/** Common words of 4+ letters that can be spelled from the puzzle's letters. */
function subAnagrams(puzzle) {
  const pool = [...puzzle];
  const fits = (w) => {
    const left = [...pool];
    for (const ch of w) {
      const i = left.indexOf(ch);
      if (i < 0) return false;
      left.splice(i, 1);
    }
    return true;
  };
  return [...common].filter((w) => w.length >= 4 && w !== puzzle && fits(w)).sort();
}

const five = [...new Set([...dict, ...common])].filter((w) => w.length === 5).sort();
const puzzles = PUZZLES.map((p) => [p, subAnagrams(p)]);

const out = `// Generated by scripts/words.mjs — do not edit by hand.
/** Every five-letter word the guess check accepts. */
export const FIVE: ReadonlySet<string> = new Set(${JSON.stringify(five)});
/** Wordle answers: the guessable subset. */
export const ANSWERS: readonly string[] = ${JSON.stringify(ANSWERS)};
/** Anagram puzzles, each with every common word of four or more letters inside it. */
export const PUZZLES: ReadonlyArray<readonly [string, readonly string[]]> = ${JSON.stringify(puzzles)};
`;
writeFileSync(OUT, out);
const counts = puzzles.map(([, words]) => words.length);
const thin = puzzles.filter(([, words]) => words.length < 8).map(([p]) => p);
if (thin.length) console.warn(`Puzzles with fewer than eight words: ${thin.join(" ")}`);
console.log(
  `five=${five.length} answers=${ANSWERS.length} puzzles=${puzzles.length} ` +
    `words-per-puzzle=${Math.min(...counts)}..${Math.max(...counts)} bytes=${out.length}`,
);
