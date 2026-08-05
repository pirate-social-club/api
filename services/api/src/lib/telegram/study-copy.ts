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
  tutorUnavailable: string
  buttonExpired: string
  alreadyHandled: string
  youSaid: string
  continueExercise: string
  chooseTranslation: string
  explainGrammar: string
  explainMeaning: string
  grammarQuestion: string
  meaningQuestion: string
  tutorDisclosure: string
  rewardPerDay(input: { amount: string }): string
}

const COPY: Record<StudyHelperLanguage, StudyCopy> = {
  en: {
    continueExercise: "▶️ Continue", chooseTranslation: "Choose the translation",
    explainGrammar: "Grammar", explainMeaning: "Meaning", grammarQuestion: "Explain the grammar in this line.", meaningQuestion: "Explain what this line means.", tutorDisclosure: "AI answer — your question and study context are sent to this community's AI provider.", rewardPerDay: ({ amount }) => `${amount} $USDC/day`,
    checkAgain: "Check again", chooseDelivery: "How should prompts be delivered?", chooseLanguage: "Your language:",
    chooseSong: "Choose a song to study:", complete: "Study complete", correct: "Correct", correctAnswer: "Correct answer", deliveryAudio: "Audio", deliveryBoth: "Audio + text",
    alreadyHandled: "That answer was already handled. Send /study if you need a new session.", buttonExpired: "This button expired. Send /study to continue.",
    deliveryText: "Text", disclosure: "The community bot owner can access and listen to voice messages sent here. Pirate also receives this recording for transcription and grading.",
    exerciseExpired: "This study exercise expired.", extra: "Extra", lineWas: "The line was", labelSeparator: ":", missing: "Missing",
    noSongs: "No songs are ready to study in this community yet.", notQuite: "Try again", nothingDetected: "(nothing detected)",
    pendingLocalization: "Translations are being prepared. Voice practice is ready now.", playSong: "🎵 Play song", processingError: "I couldn't process that answer. Send /study to restart.", sayThis: "Say this:",
    settingsLanguage: "🌐 Change language", settingsPromptFormat: "🔊 Prompt format", settingsTitle: "Study settings:",
    startAgain: "Start again", studyUnavailable: "Study is not available here yet.", tutorUnavailable: "The study tutor is unavailable right now. Your exercise is still open.", suggested: "Suggested", translationsReady: "Translations are ready.", youSaid: "You said",
  },
  zh: {
    continueExercise: "▶️ 继续", chooseTranslation: "选择译文",
    explainGrammar: "语法", explainMeaning: "含义", grammarQuestion: "解释这句的语法。", meaningQuestion: "解释这句话的意思。", tutorDisclosure: "AI 回复 — 你的问题和学习内容会发送给此社区的 AI 服务商。", rewardPerDay: ({ amount }) => `${amount} $USDC/天`,
    checkAgain: "再检查", chooseDelivery: "你希望如何接收练习提示？", chooseLanguage: "你的语言：",
    chooseSong: "选择一首歌来学习：", complete: "学习完成", correct: "正确", correctAnswer: "正确答案", deliveryAudio: "音频", deliveryBoth: "音频和文字",
    alreadyHandled: "这个答案已经处理过了。如需新练习，请发送 /study。", buttonExpired: "此按钮已过期。请发送 /study 继续。",
    deliveryText: "文字", disclosure: "社区机器人所有者可以访问并收听你在此发送的语音消息。Pirate 也会接收录音，用于转写和评分。",
    exerciseExpired: "此学习练习已过期。", extra: "多说", lineWas: "原句是", labelSeparator: "：", missing: "漏说",
    noSongs: "这个社区还没有可学习的歌曲。", notQuite: "再试一次", nothingDetected: "（未检测到语音）",
    pendingLocalization: "翻译正在准备中。现在可以先进行语音练习。", playSong: "🎵 播放歌曲", processingError: "无法处理这个答案。请发送 /study 重新开始。", sayThis: "请说：",
    settingsLanguage: "🌐 更改语言", settingsPromptFormat: "🔊 提示格式", settingsTitle: "学习设置：",
    startAgain: "重新开始", studyUnavailable: "此处暂未开放学习功能。", tutorUnavailable: "学习助手暂时不可用。练习仍在进行。", suggested: "推荐", translationsReady: "翻译已准备好。", youSaid: "你说的是",
  },
  ar: {
    continueExercise: "▶️ متابعة", chooseTranslation: "اختر الترجمة",
    explainGrammar: "القواعد", explainMeaning: "المعنى", grammarQuestion: "اشرح قواعد هذا السطر.", meaningQuestion: "اشرح معنى هذا السطر.", tutorDisclosure: "إجابة بالذكاء الاصطناعي — يُرسل سؤالك وسياق الدراسة إلى مزوّد الذكاء الاصطناعي لهذا المجتمع.", rewardPerDay: ({ amount }) => `${amount} $USDC/يوم`,
    checkAgain: "تحقق مجددًا", chooseDelivery: "كيف تريد تلقي التمارين؟", chooseLanguage: "لغتك:",
    chooseSong: "اختر أغنية للدراسة:", complete: "اكتملت الدراسة", correct: "صحيح", correctAnswer: "الإجابة الصحيحة", deliveryAudio: "صوت", deliveryBoth: "صوت ونص",
    alreadyHandled: "تمت معالجة هذه الإجابة بالفعل. أرسل /study لبدء جلسة جديدة.", buttonExpired: "انتهت صلاحية هذا الزر. أرسل /study للمتابعة.",
    deliveryText: "نص", disclosure: "يمكن لمالك روبوت المجتمع الوصول إلى الرسائل الصوتية المرسلة هنا والاستماع إليها. يتلقى Pirate التسجيل أيضًا للنسخ والتقييم.",
    exerciseExpired: "انتهت صلاحية هذا التمرين.", extra: "إضافي", lineWas: "كان السطر", labelSeparator: ":", missing: "ناقص",
    noSongs: "لا توجد أغانٍ جاهزة للدراسة في هذا المجتمع بعد.", notQuite: "حاول مرة أخرى", nothingDetected: "(لم يتم اكتشاف شيء)",
    pendingLocalization: "يجري إعداد الترجمات. التدريب الصوتي متاح الآن.", playSong: "🎵 تشغيل الأغنية", processingError: "تعذر معالجة الإجابة. أرسل /study للبدء مجددًا.", sayThis: "قل هذا:",
    settingsLanguage: "🌐 تغيير اللغة", settingsPromptFormat: "🔊 تنسيق التمرين", settingsTitle: "إعدادات الدراسة:",
    startAgain: "ابدأ مجددًا", studyUnavailable: "الدراسة غير متاحة هنا بعد.", tutorUnavailable: "مساعد الدراسة غير متاح الآن. التمرين ما زال مفتوحًا.", suggested: "مقترح", translationsReady: "الترجمات جاهزة.", youSaid: "قلت",
  },
  ka: {
    continueExercise: "▶️ გაგრძელება", chooseTranslation: "აირჩიეთ თარგმანი",
    explainGrammar: "გრამატიკა", explainMeaning: "მნიშვნელობა", grammarQuestion: "ამიხსენი ამ სტრიქონის გრამატიკა.", meaningQuestion: "ამიხსენი, რას ნიშნავს ეს სტრიქონი.", tutorDisclosure: "AI პასუხი — თქვენი შეკითხვა და სასწავლო კონტექსტი იგზავნება ამ თემის AI პროვაიდერთან.", rewardPerDay: ({ amount }) => `${amount} $USDC/დღე`,
    checkAgain: "ხელახლა შემოწმება", chooseDelivery: "როგორ გსურთ სავარჯიშოების მიღება?", chooseLanguage: "თქვენი ენა:",
    chooseSong: "აირჩიეთ სასწავლი სიმღერა:", complete: "სწავლა დასრულდა", correct: "სწორია", correctAnswer: "სწორი პასუხი", deliveryAudio: "აუდიო", deliveryBoth: "აუდიო და ტექსტი",
    alreadyHandled: "ეს პასუხი უკვე დამუშავდა. ახალი სესიისთვის გაგზავნეთ /study.", buttonExpired: "ამ ღილაკს ვადა გაუვიდა. გასაგრძელებლად გაგზავნეთ /study.",
    deliveryText: "ტექსტი", disclosure: "თემის ბოტის მფლობელს აქ გაგზავნილი ხმოვანი შეტყობინებების მოსმენა შეუძლია. Pirate-იც იღებს ჩანაწერს ტრანსკრიფციისა და შეფასებისთვის.",
    exerciseExpired: "ამ სავარჯიშოს ვადა გაუვიდა.", extra: "ზედმეტი", lineWas: "სტრიქონი იყო", labelSeparator: ":", missing: "აკლია",
    noSongs: "ამ თემში სასწავლად მზად სიმღერები ჯერ არ არის.", notQuite: "კიდევ სცადეთ", nothingDetected: "(ვერაფერი დაფიქსირდა)",
    pendingLocalization: "თარგმანები მზადდება. ხმოვანი ვარჯიში უკვე შეგიძლიათ.", playSong: "🎵 სიმღერის დაკვრა", processingError: "პასუხი ვერ დამუშავდა. თავიდან დასაწყებად გაგზავნეთ /study.", sayThis: "თქვით:",
    settingsLanguage: "🌐 ენის შეცვლა", settingsPromptFormat: "🔊 მინიშნების ფორმატი", settingsTitle: "სწავლის პარამეტრები:",
    startAgain: "თავიდან დაწყება", studyUnavailable: "სწავლა აქ ჯერ ხელმისაწვდომი არ არის.", tutorUnavailable: "სასწავლო ასისტენტი ამჟამად მიუწვდომელია. სავარჯიშო ღია რჩება.", suggested: "რეკომენდებული", translationsReady: "თარგმანები მზადაა.", youSaid: "თქვენ თქვით",
  },
  ru: {
    continueExercise: "▶️ Продолжить", chooseTranslation: "Выберите перевод",
    explainGrammar: "Грамматика", explainMeaning: "Значение", grammarQuestion: "Объясни грамматику этой строки.", meaningQuestion: "Объясни, что означает эта строка.", tutorDisclosure: "Ответ ИИ — ваш вопрос и учебный контекст отправляются ИИ-провайдеру этого сообщества.", rewardPerDay: ({ amount }) => `${amount} $USDC/день`,
    checkAgain: "Проверить снова", chooseDelivery: "Как показывать задания?", chooseLanguage: "Ваш язык:",
    chooseSong: "Выберите песню для изучения:", complete: "Урок завершён", correct: "Верно", correctAnswer: "Правильный ответ", deliveryAudio: "Аудио", deliveryBoth: "Аудио + текст",
    alreadyHandled: "Этот ответ уже обработан. Отправьте /study, чтобы начать новый урок.", buttonExpired: "Срок действия кнопки истёк. Отправьте /study, чтобы продолжить.",
    deliveryText: "Текст", disclosure: "Владелец бота сообщества может получить доступ к отправленным сюда голосовым сообщениям и прослушать их. Pirate также получает запись для расшифровки и оценки.",
    exerciseExpired: "Срок действия упражнения истёк.", extra: "Лишнее", lineWas: "Строка", labelSeparator: ":", missing: "Пропущено",
    noSongs: "В этом сообществе пока нет готовых для изучения песен.", notQuite: "Попробуйте ещё раз", nothingDetected: "(ничего не распознано)",
    pendingLocalization: "Переводы готовятся. Голосовые упражнения уже доступны.", playSong: "🎵 Воспроизвести песню", processingError: "Не удалось обработать ответ. Отправьте /study, чтобы начать заново.", sayThis: "Произнесите:",
    settingsLanguage: "🌐 Изменить язык", settingsPromptFormat: "🔊 Формат задания", settingsTitle: "Настройки обучения:",
    startAgain: "Начать заново", studyUnavailable: "Обучение здесь пока недоступно.", tutorUnavailable: "Учебный помощник сейчас недоступен. Упражнение остаётся открытым.", suggested: "Рекомендуется", translationsReady: "Переводы готовы.", youSaid: "Вы сказали",
  },
}

export function getTelegramStudyCopy(language: StudyHelperLanguage): StudyCopy {
  return COPY[language] ?? COPY.en
}

export const STUDY_LANGUAGE_BUTTONS: Array<{ code: StudyHelperLanguage; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "ar", label: "العربية" },
  { code: "ru", label: "Русский" },
  { code: "ka", label: "ქართული" },
]
