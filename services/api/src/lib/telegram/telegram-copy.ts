import type { RuntimeUiLocaleCode } from "./telegram-locale"

type TelegramStartCopyArgs = {
  community: string
}

type TelegramRewardsPendingArgs = {
  balance: string
  expiresAt: string | null
  pending: string
}

type TelegramCopy = {
  buttons: {
    checkRequest: string
    checkStatus: string
    openCommunity: string
    openPirate: string
    requestAccess: string
    verifyToJoin: string
  }
  start: {
    alreadyJoined(input: TelegramStartCopyArgs): string
    fallback(input: TelegramStartCopyArgs): string
    gateFailed(input: TelegramStartCopyArgs): string
    joined(input: TelegramStartCopyArgs): string
    linkRequired(input: TelegramStartCopyArgs): string
    overview(input: TelegramStartCopyArgs): string
    pendingRequest(input: TelegramStartCopyArgs): string
    requestable(input: TelegramStartCopyArgs): string
    requestSent(input: TelegramStartCopyArgs): string
    signIn(input: TelegramStartCopyArgs): string
    verifyRequired(input: TelegramStartCopyArgs): string
  }
  menu: {
    assistant: string
    community: string
    preferences: string
    rewards: string
    settings: string
    study: string
  }
  rewards: {
    balance(input: { balance: string }): string
    claim: string
    empty: string
    opportunities(input: { count: number }): string
    pending(input: TelegramRewardsPendingArgs): string
  }
  privateAssistant: {
    intro: string
    previewCommunityCapReached: string
    previewUnavailable: string
    previewUserCapReached: string
  }
}

const TELEGRAM_COPY: Record<RuntimeUiLocaleCode, TelegramCopy> = {
  en: {
    buttons: {
      checkRequest: "Check request",
      checkStatus: "Check status",
      openCommunity: "Open community",
      openPirate: "Open Pirate",
      requestAccess: "Request access",
      verifyToJoin: "Verify to join",
    },
    start: {
      alreadyJoined: ({ community }) => `Welcome to ${community} 🎵\n\nStudy song lyrics for free. Some songs offer rewards for learning 🪙`,
      fallback: ({ community }) => `Open ${community} in Pirate to continue.`,
      gateFailed: ({ community }) =>
        `Your Pirate account does not meet ${community}'s requirements yet. Open Pirate to review what is missing.`,
      joined: ({ community }) => `You've joined "${community}".`,
      linkRequired: ({ community }) => `Welcome to ${community}. Link your Pirate account to verify and join.`,
      overview: ({ community }) => `Welcome to ${community} 🎵\n\nStudy song lyrics for free. Some songs offer rewards for learning 🪙`,
      pendingRequest: ({ community }) =>
        `Your request to join ${community} is pending. Open Pirate to check for updates.`,
      requestable: ({ community }) => `${community} reviews new members. Open Pirate to send your access request.`,
      requestSent: ({ community }) => `Request sent for ${community}. You'll be able to enter once it's approved.`,
      signIn: ({ community }) => `Open ${community} in Pirate to sign in and continue.`,
      verifyRequired: ({ community }) => `Welcome to ${community}. Verify your Pirate account to join.`,
    },
    menu: { assistant: "💬 Ask the assistant", community: "🌐 Open community", preferences: "Change language", rewards: "🪙 Rewards", settings: "Settings", study: "📚 Study songs" },
    rewards: {
      balance: ({ balance }) => `Available rewards: ${balance}.\n\nClaiming requires a wallet and a one-time unique-human check. You can keep studying without either.`,
      claim: "Claim rewards",
      empty: "Your rewards: 0.00 USDC",
      opportunities: ({ count }) => count === 0 ? "No songs currently offer rewards." : `${count} ${count === 1 ? "song currently offers" : "songs currently offer"} rewards.`,
      pending: ({ balance, expiresAt, pending }) => `Available rewards: ${balance}\nPending rewards: ${pending}${expiresAt ? `\nKeep them before: ${expiresAt}` : ""}\n\nVerify once and connect a wallet when you're ready to keep and claim them. You can keep studying without either.`,
    },
    privateAssistant: {
      intro: "Send a question to talk to this community assistant.",
      previewCommunityCapReached: "This bot has reached today's free message limit. Try again tomorrow.",
      previewUnavailable: "This community assistant is unavailable right now. Try again later.",
      previewUserCapReached: "You've used today's free messages. Try again tomorrow.",
    },
  },
  ar: {
    buttons: {
      checkRequest: "تحقق من الطلب",
      checkStatus: "تحقق من الحالة",
      openCommunity: "افتح المجتمع",
      openPirate: "افتح Pirate",
      requestAccess: "اطلب الانضمام",
      verifyToJoin: "تحقق للانضمام",
    },
    start: {
      alreadyJoined: ({ community }) => `مرحبًا بك في ${community} 🎵\n\nتعلّم كلمات الأغاني مجانًا. بعض الأغاني تقدم مكافآت مقابل التعلم 🪙`,
      fallback: ({ community }) => `افتح ${community} في Pirate للمتابعة.`,
      gateFailed: ({ community }) =>
        `حسابك في Pirate لا يستوفي متطلبات ${community} بعد. افتح Pirate لمعرفة ما ينقصك.`,
      joined: ({ community }) => `أنت في ${community}.`,
      linkRequired: ({ community }) => `مرحباً بك في ${community}. اربط حسابك في Pirate للتحقق والانضمام.`,
      overview: ({ community }) => `مرحبًا بك في ${community} 🎵\n\nتعلّم كلمات الأغاني مجانًا. بعض الأغاني تقدم مكافآت مقابل التعلم 🪙`,
      pendingRequest: ({ community }) =>
        `طلبك للانضمام إلى ${community} قيد المراجعة. افتح Pirate للتحقق من التحديثات.`,
      requestable: ({ community }) => `يراجع ${community} الأعضاء الجدد. افتح Pirate لإرسال طلب الانضمام.`,
      requestSent: ({ community }) => `تم إرسال طلبك إلى ${community}. ستتمكن من الدخول بعد الموافقة عليه.`,
      signIn: ({ community }) => `افتح ${community} في Pirate لتسجيل الدخول والمتابعة.`,
      verifyRequired: ({ community }) => `مرحباً بك في ${community}. تحقق من حسابك في Pirate للانضمام.`,
    },
    menu: { assistant: "💬 اسأل المساعد", community: "🌐 افتح المجتمع", preferences: "تغيير اللغة", rewards: "🪙 المكافآت", settings: "الإعدادات", study: "📚 تعلّم الأغاني" },
    rewards: {
      balance: ({ balance }) => `المكافآت المتاحة: ${balance}.\n\nيتطلب الاستلام محفظة وفحصًا لمرة واحدة للتأكد من أنك شخص فريد. يمكنك متابعة التعلم من دونهما.`,
      claim: "استلم المكافآت",
      empty: "مكافآتك: 0.00 USDC",
      opportunities: ({ count }) => count === 0 ? "لا توجد أغانٍ تقدم مكافآت حاليًا." : `${count} من الأغاني تقدم مكافآت حاليًا.`,
      pending: ({ balance, expiresAt, pending }) => `المكافآت المتاحة: ${balance}\nالمكافآت المعلقة: ${pending}${expiresAt ? `\nاحتفظ بها قبل: ${expiresAt}` : ""}\n\nتحقق مرة واحدة واربط محفظة عندما تكون مستعدًا للاحتفاظ بها واستلامها. يمكنك متابعة التعلم من دونهما.`,
    },
    privateAssistant: {
      intro: "أرسل سؤالاً للتحدث مع مساعد هذا المجتمع.",
      previewCommunityCapReached: "وصل هذا البوت إلى حد الرسائل المجانية اليوم. حاول مرة أخرى غداً.",
      previewUnavailable: "مساعد هذا المجتمع غير متاح الآن. حاول مرة أخرى لاحقاً.",
      previewUserCapReached: "لقد استخدمت رسائلك المجانية اليوم. حاول مرة أخرى غداً.",
    },
  },
  zh: {
    buttons: {
      checkRequest: "查看申请",
      checkStatus: "查看状态",
      openCommunity: "打开社区",
      openPirate: "打开 Pirate",
      requestAccess: "申请加入",
      verifyToJoin: "验证并加入",
    },
    start: {
      alreadyJoined: ({ community }) => `欢迎来到 ${community} 🎵\n\n免费学习歌词。部分歌曲提供学习奖励 🪙`,
      fallback: ({ community }) => `在 Pirate 中打开 ${community} 以继续。`,
      gateFailed: ({ community }) =>
        `你的 Pirate 账号暂未满足 ${community} 的要求。打开 Pirate 查看还需要完成什么。`,
      joined: ({ community }) => `你已加入 ${community}。`,
      linkRequired: ({ community }) => `欢迎来到 ${community}。关联你的 Pirate 账号以验证并加入。`,
      overview: ({ community }) => `欢迎来到 ${community} 🎵\n\n免费学习歌词。部分歌曲提供学习奖励 🪙`,
      pendingRequest: ({ community }) =>
        `你加入 ${community} 的申请正在审核中。打开 Pirate 查看更新。`,
      requestable: ({ community }) => `${community} 会审核新成员。打开 Pirate 发送加入申请。`,
      requestSent: ({ community }) => `已向 ${community} 发送申请。通过审核后你就可以进入。`,
      signIn: ({ community }) => `在 Pirate 中打开 ${community}，登录后继续。`,
      verifyRequired: ({ community }) => `欢迎来到 ${community}。验证你的 Pirate 账号以加入。`,
    },
    menu: { assistant: "💬 询问助手", community: "🌐 打开社区", preferences: "更改语言", rewards: "🪙 奖励", settings: "设置", study: "📚 学习歌曲" },
    rewards: {
      balance: ({ balance }) => `可用奖励：${balance}。\n\n领取时需要钱包和一次真人唯一性验证。无需这些也可以继续学习。`,
      claim: "领取奖励",
      empty: "你的奖励：0.00 USDC",
      opportunities: ({ count }) => count === 0 ? "目前没有歌曲提供奖励。" : `目前有 ${count} 首歌曲提供奖励。`,
      pending: ({ balance, expiresAt, pending }) => `可用奖励：${balance}\n待确认奖励：${pending}${expiresAt ? `\n请在此时间前保留：${expiresAt}` : ""}\n\n准备好保留和领取时，再完成一次验证并连接钱包。无需这些也可以继续学习。`,
    },
    privateAssistant: {
      intro: "发送问题即可与此社区助手对话。",
      previewCommunityCapReached: "此机器人今天的免费消息额度已用完。请明天再试。",
      previewUnavailable: "此社区助手暂时不可用。请稍后再试。",
      previewUserCapReached: "你今天的免费消息已用完。请明天再试。",
    },
  },
  ka: {
    buttons: {
      checkRequest: "მოთხოვნის შემოწმება",
      checkStatus: "სტატუსის ნახვა",
      openCommunity: "საზოგადოების გახსნა",
      openPirate: "Pirate-ის გახსნა",
      requestAccess: "გაწევრიანების მოთხოვნა",
      verifyToJoin: "გაიარეთ ვერიფიკაცია",
    },
    start: {
      alreadyJoined: ({ community }) => `მოგესალმებით ${community}-ში 🎵\n\nუფასოდ ისწავლეთ სიმღერების ტექსტები. ზოგი სიმღერა სწავლისთვის ჯილდოს გთავაზობთ 🪙`,
      fallback: ({ community }) => `გასაგრძელებლად გახსენით ${community} Pirate-ში.`,
      gateFailed: ({ community }) =>
        `თქვენი Pirate ანგარიში ჯერ არ აკმაყოფილებს ${community}-ის მოთხოვნებს. გახსენით Pirate და ნახეთ, რა არის დასასრულებელი.`,
      joined: ({ community }) => `თქვენ ახლა ხართ ${community}-ში.`,
      linkRequired: ({ community }) => `მოგესალმებით ${community}-ში. გაწევრიანებისთვის დააკავშირეთ თქვენი Pirate ანგარიში.`,
      overview: ({ community }) => `მოგესალმებით ${community}-ში 🎵\n\nუფასოდ ისწავლეთ სიმღერების ტექსტები. ზოგი სიმღერა სწავლისთვის ჯილდოს გთავაზობთ 🪙`,
      pendingRequest: ({ community }) =>
        `${community}-ში გაწევრიანების მოთხოვნა განხილვაშია. განახლებებისთვის გახსენით Pirate.`,
      requestable: ({ community }) => `${community} ახალ წევრებს ამოწმებს. მოთხოვნის გასაგზავნად გახსენით Pirate.`,
      requestSent: ({ community }) => `${community}-ში გაწევრიანების მოთხოვნა გაგზავნილია. დამტკიცების შემდეგ შეძლებთ შესვლას.`,
      signIn: ({ community }) => `გასაგრძელებლად შედით Pirate-ში და გახსენით ${community}.`,
      verifyRequired: ({ community }) => `მოგესალმებით ${community}-ში. გაწევრიანებისთვის გაიარეთ თქვენი Pirate ანგარიშის ვერიფიკაცია.`,
    },
    menu: { assistant: "💬 ჰკითხეთ ასისტენტს", community: "🌐 თემის გახსნა", preferences: "ენის შეცვლა", rewards: "🪙 ჯილდოები", settings: "პარამეტრები", study: "📚 სიმღერების სწავლა" },
    rewards: {
      balance: ({ balance }) => `ხელმისაწვდომი ჯილდოები: ${balance}.\n\nმისაღებად საჭიროა საფულე და ერთჯერადი უნიკალური ადამიანის შემოწმება. სწავლა მათ გარეშეც შეგიძლიათ.`,
      claim: "ჯილდოების მიღება",
      empty: "თქვენი ჯილდოები: 0.00 USDC",
      opportunities: ({ count }) => count === 0 ? "ამჟამად არც ერთი სიმღერა არ გთავაზობთ ჯილდოს." : `${count} სიმღერა ამჟამად ჯილდოს გთავაზობთ.`,
      pending: ({ balance, expiresAt, pending }) => `ხელმისაწვდომი ჯილდოები: ${balance}\nმოლოდინში: ${pending}${expiresAt ? `\nშეინარჩუნეთ ამ დრომდე: ${expiresAt}` : ""}\n\nროცა მზად იქნებით, ერთხელ გაიარეთ შემოწმება და დააკავშირეთ საფულე. სწავლა მათ გარეშეც შეგიძლიათ.`,
    },
    privateAssistant: {
      intro: "დასვით კითხვა ამ საზოგადოების ასისტენტთან სასაუბროდ.",
      previewCommunityCapReached: "ამ ბოტმა დღევანდელი უფასო შეტყობინებების ლიმიტს მიაღწია. ხვალ სცადეთ.",
      previewUnavailable: "ამ საზოგადოების ასისტენტი ახლა მიუწვდომელია. მოგვიანებით სცადეთ.",
      previewUserCapReached: "დღევანდელი უფასო შეტყობინებები ამოიწურა. ხვალ სცადეთ.",
    },
  },
  ru: {
    buttons: {
      checkRequest: "Проверить заявку",
      checkStatus: "Проверить статус",
      openCommunity: "Открыть сообщество",
      openPirate: "Открыть Pirate",
      requestAccess: "Запросить доступ",
      verifyToJoin: "Подтвердить и вступить",
    },
    start: {
      alreadyJoined: ({ community }) => `Добро пожаловать в ${community} 🎵\n\nИзучайте тексты песен бесплатно. За изучение некоторых песен можно получать награды 🪙`,
      fallback: ({ community }) => `Откройте ${community} в Pirate, чтобы продолжить.`,
      gateFailed: ({ community }) => `Ваш аккаунт Pirate пока не соответствует требованиям ${community}. Откройте Pirate, чтобы узнать подробности.`,
      joined: ({ community }) => `Вы вступили в ${community}.`,
      linkRequired: ({ community }) => `Добро пожаловать в ${community}. Привяжите аккаунт Pirate, чтобы подтвердить его и вступить.`,
      overview: ({ community }) => `Добро пожаловать в ${community} 🎵\n\nИзучайте тексты песен бесплатно. За изучение некоторых песен можно получать награды 🪙`,
      pendingRequest: ({ community }) => `Ваша заявка на вступление в ${community} рассматривается. Откройте Pirate, чтобы проверить обновления.`,
      requestable: ({ community }) => `${community} проверяет новых участников. Откройте Pirate, чтобы отправить заявку.`,
      requestSent: ({ community }) => `Заявка на вступление в ${community} отправлена. После одобрения вы сможете войти.`,
      signIn: ({ community }) => `Откройте ${community} в Pirate, войдите в аккаунт и продолжите.`,
      verifyRequired: ({ community }) => `Добро пожаловать в ${community}. Подтвердите аккаунт Pirate, чтобы вступить.`,
    },
    menu: { assistant: "💬 Спросить помощника", community: "🌐 Открыть сообщество", preferences: "Изменить язык", rewards: "🪙 Награды", settings: "Настройки", study: "📚 Учить песни" },
    rewards: {
      balance: ({ balance }) => `Доступные награды: ${balance}.\n\nДля получения нужны кошелёк и одноразовая проверка уникальности. Продолжать учиться можно и без них.`,
      claim: "Получить награды",
      empty: "Ваши награды: 0.00 USDC",
      opportunities: ({ count }) => count === 0 ? "Сейчас ни одна песня не предлагает награды." : `Сейчас награды предлагают ${count} ${count === 1 ? "песня" : "песен"}.`,
      pending: ({ balance, expiresAt, pending }) => `Доступные награды: ${balance}\nОжидающие награды: ${pending}${expiresAt ? `\nСохраните их до: ${expiresAt}` : ""}\n\nКогда будете готовы сохранить и получить их, один раз пройдите проверку и подключите кошелёк. Продолжать учиться можно и без них.`,
    },
    privateAssistant: {
      intro: "Отправьте вопрос помощнику этого сообщества.",
      previewCommunityCapReached: "Бот исчерпал дневной лимит бесплатных сообщений. Попробуйте завтра.",
      previewUnavailable: "Помощник сообщества сейчас недоступен. Попробуйте позже.",
      previewUserCapReached: "Вы использовали дневной лимит бесплатных сообщений. Попробуйте завтра.",
    },
  },
}

export function getTelegramCopy(locale: RuntimeUiLocaleCode): TelegramCopy {
  return TELEGRAM_COPY[locale] ?? TELEGRAM_COPY.en
}
