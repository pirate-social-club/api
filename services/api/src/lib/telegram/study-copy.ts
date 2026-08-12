import type { StudyHelperLanguage } from "./study-preference-service"

type StudyCopy = {
  checkAgain: string
  chooseDelivery: string
  chooseLanguage: string
  chooseSong: string
  correct: string
  incorrect: string
  deliveryAudio: string
  deliveryBoth: string
  deliveryText: string
  disclosure: string
  exerciseExpired: string
  labelSeparator: string
  noSongs: string
  nothingDetected: string
  processingError: string
  recordingNotCaught: string
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
  questionsRemaining(input: { count: number }): string
  reviewMarker: string
  lessonComplete: string
  scoreLine(input: { correct: number; total: number }): string
  streakLine(input: { days: number }): string
  voiceTemporaryFailure: string
  voiceTerminalChatFailure: string
  voiceTerminalNonChatFailure: string
  voiceContinuationFailure: string
  miniAppCorrect: string
  miniAppIncorrect: string
  continueStudying: string
  previous: string
  next: string
  linkAccount: string
  untitledSong: string
}

const COPY: Record<StudyHelperLanguage, StudyCopy> = {
  en: {
    continueExercise: "▶️ Continue", chooseTranslation: "Choose the translation:",
    explainGrammar: "Grammar", explainMeaning: "Meaning", grammarQuestion: "Explain the grammar in this line.", meaningQuestion: "Explain what this line means.", tutorDisclosure: "AI answer — your question and study context are sent to this community's AI provider.", rewardPerDay: ({ amount }) => `${amount} $USDC/day`,
    checkAgain: "Check again", chooseDelivery: "How should prompts be delivered?", chooseLanguage: "Your language:",
    chooseSong: "Choose a song to study:", correct: "Correct", incorrect: "Incorrect", deliveryAudio: "Audio", deliveryBoth: "Audio + text",
    alreadyHandled: "That answer was already handled. Send /study if you need a new session.", buttonExpired: "This button expired. Send /study to continue.",
    deliveryText: "Text", disclosure: "The community bot owner can access and listen to voice messages sent here. Pirate also receives this recording for transcription and grading.",
    exerciseExpired: "This study exercise expired.", labelSeparator: ":",
    noSongs: "No songs are ready to study in this community yet.", nothingDetected: "(nothing detected)", recordingNotCaught: "I didn't catch that recording. Please try again.",
    pendingLocalization: "Translations are being prepared. Voice practice is ready now.", playSong: "🎵 Play song", processingError: "I couldn't process that answer. Send /study to restart.", sayThis: "Say this:",
    settingsLanguage: "🌐 Change language", settingsPromptFormat: "🔊 Prompt format", settingsTitle: "Study settings:",
    startAgain: "Start again", studyUnavailable: "Study is not available here yet.", tutorUnavailable: "The study tutor is unavailable right now. Your exercise is still open.", suggested: "Suggested", translationsReady: "Translations are ready.", youSaid: "You said",
    questionsRemaining: ({ count }) => `Questions left: ${count}`, reviewMarker: "Review", lessonComplete: "Lesson complete", scoreLine: ({ correct, total }) => `✅ ${correct}/${total}`, streakLine: ({ days }) => `🔥 ${days} day${days === 1 ? "" : "s"}`,
    voiceTemporaryFailure: "I couldn't understand that recording. Send another voice message to try again.", voiceTerminalChatFailure: "I couldn't understand the recording after several tries. Send /study to start again.", voiceTerminalNonChatFailure: "I couldn't understand the recording after several tries. Reopen study to start again.", voiceContinuationFailure: "Your answer was saved, but the lesson couldn't continue. Send /study to resume.", miniAppCorrect: "Correct. Continue studying in the Mini App.", miniAppIncorrect: "Incorrect. Continue studying to review this question.", continueStudying: "Continue studying",
    previous: "Previous", next: "Next", linkAccount: "Link your Telegram account before studying here.", untitledSong: "Untitled song",
  },
  zh: {
    continueExercise: "▶️ 继续", chooseTranslation: "选择译文：",
    explainGrammar: "语法", explainMeaning: "含义", grammarQuestion: "解释这句的语法。", meaningQuestion: "解释这句话的意思。", tutorDisclosure: "AI 回复 — 你的问题和学习内容会发送给此社区的 AI 服务商。", rewardPerDay: ({ amount }) => `${amount} $USDC/天`,
    checkAgain: "再检查", chooseDelivery: "你希望如何接收练习提示？", chooseLanguage: "你的语言：",
    chooseSong: "选择一首歌来学习：", correct: "正确", incorrect: "不正确", deliveryAudio: "音频", deliveryBoth: "音频和文字",
    alreadyHandled: "这个答案已经处理过了。如需新练习，请发送 /study。", buttonExpired: "此按钮已过期。请发送 /study 继续。",
    deliveryText: "文字", disclosure: "社区机器人所有者可以访问并收听你在此发送的语音消息。Pirate 也会接收录音，用于转写和评分。",
    exerciseExpired: "此学习练习已过期。", labelSeparator: "：",
    noSongs: "这个社区还没有可学习的歌曲。", nothingDetected: "（未检测到语音）", recordingNotCaught: "没有听清这段录音。请再试一次。",
    pendingLocalization: "翻译正在准备中。现在可以先进行语音练习。", playSong: "🎵 播放歌曲", processingError: "无法处理这个答案。请发送 /study 重新开始。", sayThis: "请说：",
    settingsLanguage: "🌐 更改语言", settingsPromptFormat: "🔊 提示格式", settingsTitle: "学习设置：",
    startAgain: "重新开始", studyUnavailable: "此处暂未开放学习功能。", tutorUnavailable: "学习助手暂时不可用。练习仍在进行。", suggested: "推荐", translationsReady: "翻译已准备好。", youSaid: "你说的是",
    questionsRemaining: ({ count }) => `剩余问题：${count}`, reviewMarker: "复习", lessonComplete: "课程完成", scoreLine: ({ correct, total }) => `✅ ${correct}/${total}`, streakLine: ({ days }) => `🔥 连续 ${days} 天`,
    voiceTemporaryFailure: "无法识别这段录音。请发送另一条语音消息重试。", voiceTerminalChatFailure: "多次尝试后仍无法识别录音。请发送 /study 重新开始。", voiceTerminalNonChatFailure: "多次尝试后仍无法识别录音。请重新打开学习页面。", voiceContinuationFailure: "答案已保存，但课程无法继续。请发送 /study 恢复。", miniAppCorrect: "正确。请在 Mini App 中继续学习。", miniAppIncorrect: "不正确。请在 Mini App 中继续复习此题。", continueStudying: "继续学习",
    previous: "上一页", next: "下一页", linkAccount: "请先关联 Telegram 账户再开始学习。", untitledSong: "未命名歌曲",
  },
  ar: {
    continueExercise: "▶️ متابعة", chooseTranslation: "اختر الترجمة:",
    explainGrammar: "القواعد", explainMeaning: "المعنى", grammarQuestion: "اشرح قواعد هذا السطر.", meaningQuestion: "اشرح معنى هذا السطر.", tutorDisclosure: "إجابة بالذكاء الاصطناعي — يُرسل سؤالك وسياق الدراسة إلى مزوّد الذكاء الاصطناعي لهذا المجتمع.", rewardPerDay: ({ amount }) => `${amount} $USDC/يوم`,
    checkAgain: "تحقق مجددًا", chooseDelivery: "كيف تريد تلقي التمارين؟", chooseLanguage: "لغتك:",
    chooseSong: "اختر أغنية للدراسة:", correct: "صحيح", incorrect: "غير صحيح", deliveryAudio: "صوت", deliveryBoth: "صوت ونص",
    alreadyHandled: "تمت معالجة هذه الإجابة بالفعل. أرسل /study لبدء جلسة جديدة.", buttonExpired: "انتهت صلاحية هذا الزر. أرسل /study للمتابعة.",
    deliveryText: "نص", disclosure: "يمكن لمالك روبوت المجتمع الوصول إلى الرسائل الصوتية المرسلة هنا والاستماع إليها. يتلقى Pirate التسجيل أيضًا للنسخ والتقييم.",
    exerciseExpired: "انتهت صلاحية هذا التمرين.", labelSeparator: ":",
    noSongs: "لا توجد أغانٍ جاهزة للدراسة في هذا المجتمع بعد.", nothingDetected: "(لم يتم اكتشاف شيء)", recordingNotCaught: "لم أتمكن من فهم التسجيل. حاول مرة أخرى.",
    pendingLocalization: "يجري إعداد الترجمات. التدريب الصوتي متاح الآن.", playSong: "🎵 تشغيل الأغنية", processingError: "تعذر معالجة الإجابة. أرسل /study للبدء مجددًا.", sayThis: "قل هذا:",
    settingsLanguage: "🌐 تغيير اللغة", settingsPromptFormat: "🔊 تنسيق التمرين", settingsTitle: "إعدادات الدراسة:",
    startAgain: "ابدأ مجددًا", studyUnavailable: "الدراسة غير متاحة هنا بعد.", tutorUnavailable: "مساعد الدراسة غير متاح الآن. التمرين ما زال مفتوحًا.", suggested: "مقترح", translationsReady: "الترجمات جاهزة.", youSaid: "قلت",
    questionsRemaining: ({ count }) => `الأسئلة المتبقية: ${count}`, reviewMarker: "مراجعة", lessonComplete: "اكتمل الدرس", scoreLine: ({ correct, total }) => `✅ ${correct}/${total}`, streakLine: ({ days }) => `🔥 أيام متتالية: ${days}`,
    voiceTemporaryFailure: "تعذر فهم هذا التسجيل. أرسل رسالة صوتية أخرى للمحاولة مجددًا.", voiceTerminalChatFailure: "تعذر فهم التسجيل بعد عدة محاولات. أرسل /study للبدء مجددًا.", voiceTerminalNonChatFailure: "تعذر فهم التسجيل بعد عدة محاولات. أعد فتح الدراسة للبدء مجددًا.", voiceContinuationFailure: "حُفظت إجابتك، لكن تعذر مواصلة الدرس. أرسل /study للمتابعة.", miniAppCorrect: "صحيح. تابع الدراسة في التطبيق المصغر.", miniAppIncorrect: "غير صحيح. تابع الدراسة في التطبيق المصغر لمراجعة هذا السؤال.", continueStudying: "متابعة الدراسة",
    previous: "السابق", next: "التالي", linkAccount: "اربط حساب Telegram قبل بدء الدراسة هنا.", untitledSong: "أغنية بلا عنوان",
  },
  ka: {
    continueExercise: "▶️ გაგრძელება", chooseTranslation: "აირჩიეთ თარგმანი:",
    explainGrammar: "გრამატიკა", explainMeaning: "მნიშვნელობა", grammarQuestion: "ამიხსენი ამ სტრიქონის გრამატიკა.", meaningQuestion: "ამიხსენი, რას ნიშნავს ეს სტრიქონი.", tutorDisclosure: "AI პასუხი — თქვენი შეკითხვა და სასწავლო კონტექსტი იგზავნება ამ თემის AI პროვაიდერთან.", rewardPerDay: ({ amount }) => `${amount} $USDC/დღე`,
    checkAgain: "ხელახლა შემოწმება", chooseDelivery: "როგორ გსურთ სავარჯიშოების მიღება?", chooseLanguage: "თქვენი ენა:",
    chooseSong: "აირჩიეთ სასწავლი სიმღერა:", correct: "სწორია", incorrect: "არასწორია", deliveryAudio: "აუდიო", deliveryBoth: "აუდიო და ტექსტი",
    alreadyHandled: "ეს პასუხი უკვე დამუშავდა. ახალი სესიისთვის გაგზავნეთ /study.", buttonExpired: "ამ ღილაკს ვადა გაუვიდა. გასაგრძელებლად გაგზავნეთ /study.",
    deliveryText: "ტექსტი", disclosure: "თემის ბოტის მფლობელს აქ გაგზავნილი ხმოვანი შეტყობინებების მოსმენა შეუძლია. Pirate-იც იღებს ჩანაწერს ტრანსკრიფციისა და შეფასებისთვის.",
    exerciseExpired: "ამ სავარჯიშოს ვადა გაუვიდა.", labelSeparator: ":",
    noSongs: "ამ თემში სასწავლად მზად სიმღერები ჯერ არ არის.", nothingDetected: "(ვერაფერი დაფიქსირდა)", recordingNotCaught: "ჩანაწერი ვერ გავიგე. გთხოვთ, სცადოთ ხელახლა.",
    pendingLocalization: "თარგმანები მზადდება. ხმოვანი ვარჯიში უკვე შეგიძლიათ.", playSong: "🎵 სიმღერის დაკვრა", processingError: "პასუხი ვერ დამუშავდა. თავიდან დასაწყებად გაგზავნეთ /study.", sayThis: "თქვით:",
    settingsLanguage: "🌐 ენის შეცვლა", settingsPromptFormat: "🔊 მინიშნების ფორმატი", settingsTitle: "სწავლის პარამეტრები:",
    startAgain: "თავიდან დაწყება", studyUnavailable: "სწავლა აქ ჯერ ხელმისაწვდომი არ არის.", tutorUnavailable: "სასწავლო ასისტენტი ამჟამად მიუწვდომელია. სავარჯიშო ღია რჩება.", suggested: "რეკომენდებული", translationsReady: "თარგმანები მზადაა.", youSaid: "თქვენ თქვით",
    questionsRemaining: ({ count }) => `დარჩენილი კითხვები: ${count}`, reviewMarker: "გამეორება", lessonComplete: "გაკვეთილი დასრულდა", scoreLine: ({ correct, total }) => `✅ ${correct}/${total}`, streakLine: ({ days }) => `🔥 ზედიზედ დღეები: ${days}`,
    voiceTemporaryFailure: "ჩანაწერის გაგება ვერ მოხერხდა. სცადეთ სხვა ხმოვანი შეტყობინების გაგზავნა.", voiceTerminalChatFailure: "რამდენიმე მცდელობის შემდეგ ჩანაწერის გაგება ვერ მოხერხდა. თავიდან დასაწყებად გაგზავნეთ /study.", voiceTerminalNonChatFailure: "რამდენიმე მცდელობის შემდეგ ჩანაწერის გაგება ვერ მოხერხდა. თავიდან დასაწყებად ხელახლა გახსენით სწავლა.", voiceContinuationFailure: "თქვენი პასუხი შენახულია, მაგრამ გაკვეთილი ვერ გაგრძელდა. გასაგრძელებლად გაგზავნეთ /study.", miniAppCorrect: "სწორია. სწავლა Mini App-ში გააგრძელეთ.", miniAppIncorrect: "არასწორია. ამ კითხვის გასამეორებლად სწავლა Mini App-ში გააგრძელეთ.", continueStudying: "სწავლის გაგრძელება",
    previous: "წინა", next: "შემდეგი", linkAccount: "სწავლის დაწყებამდე დააკავშირეთ Telegram-ის ანგარიში.", untitledSong: "უსათაურო სიმღერა",
  },
  ru: {
    continueExercise: "▶️ Продолжить", chooseTranslation: "Выберите перевод:",
    explainGrammar: "Грамматика", explainMeaning: "Значение", grammarQuestion: "Объясни грамматику этой строки.", meaningQuestion: "Объясни, что означает эта строка.", tutorDisclosure: "Ответ ИИ — ваш вопрос и учебный контекст отправляются ИИ-провайдеру этого сообщества.", rewardPerDay: ({ amount }) => `${amount} $USDC/день`,
    checkAgain: "Проверить снова", chooseDelivery: "Как показывать задания?", chooseLanguage: "Ваш язык:",
    chooseSong: "Выберите песню для изучения:", correct: "Верно", incorrect: "Неверно", deliveryAudio: "Аудио", deliveryBoth: "Аудио + текст",
    alreadyHandled: "Этот ответ уже обработан. Отправьте /study, чтобы начать новый урок.", buttonExpired: "Срок действия кнопки истёк. Отправьте /study, чтобы продолжить.",
    deliveryText: "Текст", disclosure: "Владелец бота сообщества может получить доступ к отправленным сюда голосовым сообщениям и прослушать их. Pirate также получает запись для расшифровки и оценки.",
    exerciseExpired: "Срок действия упражнения истёк.", labelSeparator: ":",
    noSongs: "В этом сообществе пока нет готовых для изучения песен.", nothingDetected: "(ничего не распознано)", recordingNotCaught: "Не удалось разобрать запись. Попробуйте ещё раз.",
    pendingLocalization: "Переводы готовятся. Голосовые упражнения уже доступны.", playSong: "🎵 Воспроизвести песню", processingError: "Не удалось обработать ответ. Отправьте /study, чтобы начать заново.", sayThis: "Произнесите:",
    settingsLanguage: "🌐 Изменить язык", settingsPromptFormat: "🔊 Формат задания", settingsTitle: "Настройки обучения:",
    startAgain: "Начать заново", studyUnavailable: "Обучение здесь пока недоступно.", tutorUnavailable: "Учебный помощник сейчас недоступен. Упражнение остаётся открытым.", suggested: "Рекомендуется", translationsReady: "Переводы готовы.", youSaid: "Вы сказали",
    questionsRemaining: ({ count }) => `Осталось вопросов: ${count}`, reviewMarker: "Повтор", lessonComplete: "Урок завершён", scoreLine: ({ correct, total }) => `✅ ${correct}/${total}`, streakLine: ({ days }) => `🔥 Дней подряд: ${days}`,
    voiceTemporaryFailure: "Не удалось распознать запись. Отправьте другое голосовое сообщение.", voiceTerminalChatFailure: "Не удалось распознать запись после нескольких попыток. Отправьте /study, чтобы начать заново.", voiceTerminalNonChatFailure: "Не удалось распознать запись после нескольких попыток. Откройте обучение заново.", voiceContinuationFailure: "Ответ сохранён, но урок не удалось продолжить. Отправьте /study, чтобы вернуться.", miniAppCorrect: "Верно. Продолжите обучение в Mini App.", miniAppIncorrect: "Неверно. Продолжите обучение в Mini App, чтобы повторить этот вопрос.", continueStudying: "Продолжить обучение",
    previous: "Назад", next: "Далее", linkAccount: "Свяжите аккаунт Telegram, прежде чем начать обучение.", untitledSong: "Песня без названия",
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
