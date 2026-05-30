import type { RuntimeUiLocaleCode } from "./telegram-locale"

type TelegramStartCopyArgs = {
  community: string
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
    pendingRequest(input: TelegramStartCopyArgs): string
    requestable(input: TelegramStartCopyArgs): string
    requestSent(input: TelegramStartCopyArgs): string
    signIn(input: TelegramStartCopyArgs): string
    verifyRequired(input: TelegramStartCopyArgs): string
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
      alreadyJoined: ({ community }) => `You've already joined "${community}".`,
      fallback: ({ community }) => `Open ${community} in Pirate to continue.`,
      gateFailed: ({ community }) =>
        `Your Pirate account does not meet ${community}'s requirements yet. Open Pirate to review what is missing.`,
      joined: ({ community }) => `You've joined "${community}".`,
      linkRequired: ({ community }) => `Welcome to ${community}. Link your Pirate account to verify and join.`,
      pendingRequest: ({ community }) =>
        `Your request to join ${community} is pending. Open Pirate to check for updates.`,
      requestable: ({ community }) => `${community} reviews new members. Open Pirate to send your access request.`,
      requestSent: ({ community }) => `Request sent for ${community}. You'll be able to enter once it's approved.`,
      signIn: ({ community }) => `Open ${community} in Pirate to sign in and continue.`,
      verifyRequired: ({ community }) => `Welcome to ${community}. Verify your Pirate account to join.`,
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
      alreadyJoined: ({ community }) => `أنت في ${community}.`,
      fallback: ({ community }) => `افتح ${community} في Pirate للمتابعة.`,
      gateFailed: ({ community }) =>
        `حسابك في Pirate لا يستوفي متطلبات ${community} بعد. افتح Pirate لمعرفة ما ينقصك.`,
      joined: ({ community }) => `أنت في ${community}.`,
      linkRequired: ({ community }) => `مرحباً بك في ${community}. اربط حسابك في Pirate للتحقق والانضمام.`,
      pendingRequest: ({ community }) =>
        `طلبك للانضمام إلى ${community} قيد المراجعة. افتح Pirate للتحقق من التحديثات.`,
      requestable: ({ community }) => `يراجع ${community} الأعضاء الجدد. افتح Pirate لإرسال طلب الانضمام.`,
      requestSent: ({ community }) => `تم إرسال طلبك إلى ${community}. ستتمكن من الدخول بعد الموافقة عليه.`,
      signIn: ({ community }) => `افتح ${community} في Pirate لتسجيل الدخول والمتابعة.`,
      verifyRequired: ({ community }) => `مرحباً بك في ${community}. تحقق من حسابك في Pirate للانضمام.`,
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
      alreadyJoined: ({ community }) => `你已加入 ${community}。`,
      fallback: ({ community }) => `在 Pirate 中打开 ${community} 以继续。`,
      gateFailed: ({ community }) =>
        `你的 Pirate 账号暂未满足 ${community} 的要求。打开 Pirate 查看还需要完成什么。`,
      joined: ({ community }) => `你已加入 ${community}。`,
      linkRequired: ({ community }) => `欢迎来到 ${community}。关联你的 Pirate 账号以验证并加入。`,
      pendingRequest: ({ community }) =>
        `你加入 ${community} 的申请正在审核中。打开 Pirate 查看更新。`,
      requestable: ({ community }) => `${community} 会审核新成员。打开 Pirate 发送加入申请。`,
      requestSent: ({ community }) => `已向 ${community} 发送申请。通过审核后你就可以进入。`,
      signIn: ({ community }) => `在 Pirate 中打开 ${community}，登录后继续。`,
      verifyRequired: ({ community }) => `欢迎来到 ${community}。验证你的 Pirate 账号以加入。`,
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
      alreadyJoined: ({ community }) => `თქვენ უკვე ხართ ${community}-ში.`,
      fallback: ({ community }) => `გასაგრძელებლად გახსენით ${community} Pirate-ში.`,
      gateFailed: ({ community }) =>
        `თქვენი Pirate ანგარიში ჯერ არ აკმაყოფილებს ${community}-ის მოთხოვნებს. გახსენით Pirate და ნახეთ, რა არის დასასრულებელი.`,
      joined: ({ community }) => `თქვენ ახლა ხართ ${community}-ში.`,
      linkRequired: ({ community }) => `მოგესალმებით ${community}-ში. გაწევრიანებისთვის დააკავშირეთ თქვენი Pirate ანგარიში.`,
      pendingRequest: ({ community }) =>
        `${community}-ში გაწევრიანების მოთხოვნა განხილვაშია. განახლებებისთვის გახსენით Pirate.`,
      requestable: ({ community }) => `${community} ახალ წევრებს ამოწმებს. მოთხოვნის გასაგზავნად გახსენით Pirate.`,
      requestSent: ({ community }) => `${community}-ში გაწევრიანების მოთხოვნა გაგზავნილია. დამტკიცების შემდეგ შეძლებთ შესვლას.`,
      signIn: ({ community }) => `გასაგრძელებლად შედით Pirate-ში და გახსენით ${community}.`,
      verifyRequired: ({ community }) => `მოგესალმებით ${community}-ში. გაწევრიანებისთვის გაიარეთ თქვენი Pirate ანგარიშის ვერიფიკაცია.`,
    },
  },
}

export function getTelegramCopy(locale: RuntimeUiLocaleCode): TelegramCopy {
  return TELEGRAM_COPY[locale] ?? TELEGRAM_COPY.en
}
