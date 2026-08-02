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
  disclosure: string
  exerciseExpired: string
  extra: string
  lineWas: string
  labelSeparator: string
  missing: string
  noSongs: string
  notQuite: string
  nothingDetected: string
  processingError: string
  pendingLocalization: string
  playSong: string
  translationsReady: string
  sayThis: string
  settingsLanguage: string
  settingsPromptFormat: string
  settingsTitle: string
  startAgain: string
  suggested: string
  studyUnavailable: string
  buttonExpired: string
  alreadyHandled: string
  youSaid: string
}

const COPY: Record<StudyHelperLanguage, StudyCopy> = {
  en: {
    checkAgain: "Check again", chooseDelivery: "How should prompts be delivered?", chooseLanguage: "Choose your helper language:",
    chooseSong: "Choose a song to study:", complete: "Study complete", correct: "Correct", correctAnswer: "Correct answer", deliveryAudio: "Audio", deliveryBoth: "Audio + text",
    alreadyHandled: "That answer was already handled. Send /study if you need a new session.", buttonExpired: "This button expired. Send /study to continue.",
    deliveryText: "Text", disclosure: "The community bot owner can access and listen to voice messages sent here. Pirate also receives this recording for transcription and grading.",
    exerciseExpired: "This study exercise expired.", extra: "Extra", lineWas: "The line was", labelSeparator: ":", missing: "Missing",
    noSongs: "No songs are ready to study in this community yet.", notQuite: "Not quite", nothingDetected: "(nothing detected)",
    pendingLocalization: "Translations are being prepared. Voice practice is ready now.", playSong: "🎵 Play song", processingError: "I couldn't process that answer. Send /study to restart.", sayThis: "Say this:",
    settingsLanguage: "⚙️ Language", settingsPromptFormat: "🔊 Prompt format", settingsTitle: "Study settings:",
    startAgain: "Start again", studyUnavailable: "Study is not available here yet.", suggested: "Suggested", translationsReady: "Translations are ready.", youSaid: "You said",
  },
  zh: {
    checkAgain: "再检查", chooseDelivery: "你希望如何接收练习提示？", chooseLanguage: "选择辅助语言：",
    chooseSong: "选择一首歌来学习：", complete: "学习完成", correct: "正确", correctAnswer: "正确答案", deliveryAudio: "音频", deliveryBoth: "音频和文字",
    alreadyHandled: "这个答案已经处理过了。如需新练习，请发送 /study。", buttonExpired: "此按钮已过期。请发送 /study 继续。",
    deliveryText: "文字", disclosure: "社区机器人所有者可以访问并收听你在此发送的语音消息。Pirate 也会接收录音，用于转写和评分。",
    exerciseExpired: "此学习练习已过期。", extra: "多说", lineWas: "原句是", labelSeparator: "：", missing: "漏说",
    noSongs: "这个社区还没有可学习的歌曲。", notQuite: "还不完全正确", nothingDetected: "（未检测到语音）",
    pendingLocalization: "翻译正在准备中。现在可以先进行语音练习。", playSong: "🎵 播放歌曲", processingError: "无法处理这个答案。请发送 /study 重新开始。", sayThis: "请说：",
    settingsLanguage: "⚙️ 语言", settingsPromptFormat: "🔊 提示格式", settingsTitle: "学习设置：",
    startAgain: "重新开始", studyUnavailable: "此处暂未开放学习功能。", suggested: "推荐", translationsReady: "翻译已准备好。", youSaid: "你说的是",
  },
  ar: {
    checkAgain: "تحقق مجددًا", chooseDelivery: "كيف تريد تلقي التمارين؟", chooseLanguage: "اختر لغة المساعدة:",
    chooseSong: "اختر أغنية للدراسة:", complete: "اكتملت الدراسة", correct: "صحيح", correctAnswer: "الإجابة الصحيحة", deliveryAudio: "صوت", deliveryBoth: "صوت ونص",
    alreadyHandled: "تمت معالجة هذه الإجابة بالفعل. أرسل /study لبدء جلسة جديدة.", buttonExpired: "انتهت صلاحية هذا الزر. أرسل /study للمتابعة.",
    deliveryText: "نص", disclosure: "يمكن لمالك روبوت المجتمع الوصول إلى الرسائل الصوتية المرسلة هنا والاستماع إليها. يتلقى Pirate التسجيل أيضًا للنسخ والتقييم.",
    exerciseExpired: "انتهت صلاحية هذا التمرين.", extra: "إضافي", lineWas: "كان السطر", labelSeparator: ":", missing: "ناقص",
    noSongs: "لا توجد أغانٍ جاهزة للدراسة في هذا المجتمع بعد.", notQuite: "ليس تمامًا", nothingDetected: "(لم يتم اكتشاف شيء)",
    pendingLocalization: "يجري إعداد الترجمات. التدريب الصوتي متاح الآن.", playSong: "🎵 تشغيل الأغنية", processingError: "تعذر معالجة الإجابة. أرسل /study للبدء مجددًا.", sayThis: "قل هذا:",
    settingsLanguage: "⚙️ اللغة", settingsPromptFormat: "🔊 تنسيق التمرين", settingsTitle: "إعدادات الدراسة:",
    startAgain: "ابدأ مجددًا", studyUnavailable: "الدراسة غير متاحة هنا بعد.", suggested: "مقترح", translationsReady: "الترجمات جاهزة.", youSaid: "قلت",
  },
  ka: {
    checkAgain: "ხელახლა შემოწმება", chooseDelivery: "როგორ გსურთ სავარჯიშოების მიღება?", chooseLanguage: "აირჩიეთ დამხმარე ენა:",
    chooseSong: "აირჩიეთ სასწავლი სიმღერა:", complete: "სწავლა დასრულდა", correct: "სწორია", correctAnswer: "სწორი პასუხი", deliveryAudio: "აუდიო", deliveryBoth: "აუდიო და ტექსტი",
    alreadyHandled: "ეს პასუხი უკვე დამუშავდა. ახალი სესიისთვის გაგზავნეთ /study.", buttonExpired: "ამ ღილაკს ვადა გაუვიდა. გასაგრძელებლად გაგზავნეთ /study.",
    deliveryText: "ტექსტი", disclosure: "თემის ბოტის მფლობელს აქ გაგზავნილი ხმოვანი შეტყობინებების მოსმენა შეუძლია. Pirate-იც იღებს ჩანაწერს ტრანსკრიფციისა და შეფასებისთვის.",
    exerciseExpired: "ამ სავარჯიშოს ვადა გაუვიდა.", extra: "ზედმეტი", lineWas: "სტრიქონი იყო", labelSeparator: ":", missing: "აკლია",
    noSongs: "ამ თემში სასწავლად მზად სიმღერები ჯერ არ არის.", notQuite: "მთლად არა", nothingDetected: "(ვერაფერი დაფიქსირდა)",
    pendingLocalization: "თარგმანები მზადდება. ხმოვანი ვარჯიში უკვე შეგიძლიათ.", playSong: "🎵 სიმღერის დაკვრა", processingError: "პასუხი ვერ დამუშავდა. თავიდან დასაწყებად გაგზავნეთ /study.", sayThis: "თქვით:",
    settingsLanguage: "⚙️ ენა", settingsPromptFormat: "🔊 მინიშნების ფორმატი", settingsTitle: "სწავლის პარამეტრები:",
    startAgain: "თავიდან დაწყება", studyUnavailable: "სწავლა აქ ჯერ ხელმისაწვდომი არ არის.", suggested: "რეკომენდებული", translationsReady: "თარგმანები მზადაა.", youSaid: "თქვენ თქვით",
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
