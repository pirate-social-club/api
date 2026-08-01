import type { StudyHelperLanguage } from "./study-preference-service"

type StudyCopy = {
  checkAgain: string
  chooseDelivery: string
  chooseLanguage: string
  chooseSong: string
  complete: string
  correct: string
  correctAnswer: string
  deliveryAudio: string
  deliveryBoth: string
  deliveryText: string
  lineWas: string
  labelSeparator: string
  noSongs: string
  notQuite: string
  pendingLocalization: string
  translationsReady: string
  sayThis: string
  youSaid: string
}

const COPY: Record<StudyHelperLanguage, StudyCopy> = {
  en: {
    checkAgain: "Check again", chooseDelivery: "How should prompts be delivered?", chooseLanguage: "Choose your helper language:",
    chooseSong: "Choose a song to study:", complete: "Study complete", correct: "Correct", correctAnswer: "Correct answer", deliveryAudio: "Audio", deliveryBoth: "Audio + text",
    deliveryText: "Text", lineWas: "The line was", labelSeparator: ":", noSongs: "No songs are ready to study in this community yet.", notQuite: "Not quite",
    pendingLocalization: "Translations are being prepared. Voice practice is ready now.", sayThis: "Say this:", translationsReady: "Translations are ready.", youSaid: "You said",
  },
  zh: {
    checkAgain: "再检查", chooseDelivery: "你希望如何接收练习提示？", chooseLanguage: "选择辅助语言：",
    chooseSong: "选择一首歌来学习：", complete: "学习完成", correct: "正确", correctAnswer: "正确答案", deliveryAudio: "音频", deliveryBoth: "音频和文字",
    deliveryText: "文字", lineWas: "原句是", labelSeparator: "：", noSongs: "这个社区还没有可学习的歌曲。", notQuite: "还不完全正确",
    pendingLocalization: "翻译正在准备中。现在可以先进行语音练习。", sayThis: "请说：", translationsReady: "翻译已准备好。", youSaid: "你说的是",
  },
  ar: {
    checkAgain: "تحقق مجددًا", chooseDelivery: "كيف تريد تلقي التمارين؟", chooseLanguage: "اختر لغة المساعدة:",
    chooseSong: "اختر أغنية للدراسة:", complete: "اكتملت الدراسة", correct: "صحيح", correctAnswer: "الإجابة الصحيحة", deliveryAudio: "صوت", deliveryBoth: "صوت ونص",
    deliveryText: "نص", lineWas: "كان السطر", labelSeparator: ":", noSongs: "لا توجد أغانٍ جاهزة للدراسة في هذا المجتمع بعد.", notQuite: "ليس تمامًا",
    pendingLocalization: "يجري إعداد الترجمات. التدريب الصوتي متاح الآن.", sayThis: "قل هذا:", translationsReady: "الترجمات جاهزة.", youSaid: "قلت",
  },
  ka: {
    checkAgain: "ხელახლა შემოწმება", chooseDelivery: "როგორ გსურთ სავარჯიშოების მიღება?", chooseLanguage: "აირჩიეთ დამხმარე ენა:",
    chooseSong: "აირჩიეთ სასწავლი სიმღერა:", complete: "სწავლა დასრულდა", correct: "სწორია", correctAnswer: "სწორი პასუხი", deliveryAudio: "აუდიო", deliveryBoth: "აუდიო და ტექსტი",
    deliveryText: "ტექსტი", lineWas: "სტრიქონი იყო", labelSeparator: ":", noSongs: "ამ თემში სასწავლად მზად სიმღერები ჯერ არ არის.", notQuite: "მთლად არა",
    pendingLocalization: "თარგმანები მზადდება. ხმოვანი ვარჯიში უკვე შეგიძლიათ.", sayThis: "თქვით:", translationsReady: "თარგმანები მზადაა.", youSaid: "თქვენ თქვით",
  },
}

export function getTelegramStudyCopy(language: StudyHelperLanguage): StudyCopy {
  return COPY[language] ?? COPY.en
}

export const STUDY_LANGUAGE_BUTTONS: Array<{ code: StudyHelperLanguage; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "ar", label: "العربية" },
  { code: "ka", label: "ქართული" },
]
