/**
 * Per-locale strings for transactional emails.
 *
 * Each top-level key is a template id (matches the corresponding
 * `buildXxxTemplate` method in `email.service.ts`). Each entry has a
 * `subject`, plus optional inline strings used by the HTML body. The
 * `buildXxxTemplate` methods read these via `tEmail(locale, ...)`.
 *
 * Locales kept strictly in sync with `frontend/src/i18n/config.ts`.
 */

type EmailLocale = 'en' | 'sk' | 'de' | 'ru' | 'ar' | 'tr';

const FALLBACK: EmailLocale = 'en';
const SUPPORTED: readonly EmailLocale[] = ['en', 'sk', 'de', 'ru', 'ar', 'tr'];

interface EmailTemplateStrings {
  subject: string;
  heading?: string;
  greeting?: string;
  intro?: string;
  buttonLabel?: string;
  fallbackLinkLabel?: string;
  outro?: string;
  signoff?: string;
  notice?: string;
  htmlDir?: 'ltr' | 'rtl';
}

type TemplateKey =
  | 'activation'
  | 'passwordReset'
  | 'passwordResetAdmin'
  | 'twoFactor'
  | 'passwordChanged'
  | 'passwordExpired'
  | 'accountLocked'
  | 'welcome'
  | 'applicationConfirmation'
  | 'notification';

const EMAIL_TRANSLATIONS: Record<EmailLocale, Record<TemplateKey, EmailTemplateStrings>> = {
  en: {
    activation: {
      subject: 'Activate Your TempWorks Account',
      heading: 'Activate Your Account',
      greeting: 'Hi {{name}},',
      intro: "Welcome to TempWorks. Click the button below to activate your account and set your password.",
      buttonLabel: 'Activate Account',
      fallbackLinkLabel: 'Or paste this URL into your browser:',
      outro: 'This link expires in 24 hours. If you did not request this, please ignore this email.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    passwordReset: {
      subject: 'Reset Your TempWorks Password',
      heading: 'Reset Your Password',
      greeting: 'Hi {{name}},',
      intro: 'We received a request to reset your password. Click the button below to choose a new one.',
      buttonLabel: 'Reset Password',
      fallbackLinkLabel: 'Or paste this URL into your browser:',
      outro: 'This link expires in 1 hour. If you did not request a reset, you can safely ignore this email.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    passwordResetAdmin: {
      subject: 'Your TempWorks Password Has Been Reset by an Administrator',
      heading: 'Password Reset by Administrator',
      greeting: 'Hi {{name}},',
      intro: 'An administrator has initiated a password reset for your account. Click the button below to choose a new password.',
      buttonLabel: 'Set New Password',
      fallbackLinkLabel: 'Or paste this URL into your browser:',
      outro: 'For security, please contact your administrator if you did not expect this email.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    twoFactor: {
      subject: 'Your TempWorks Verification Code',
      heading: 'Verification Code',
      greeting: 'Hi {{name}},',
      intro: 'Use the code below to complete your sign-in. This code expires in {{minutes}} minutes.',
      outro: 'If you did not try to sign in, please change your password immediately.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    passwordChanged: {
      subject: 'Your TempWorks Password Was Changed',
      heading: 'Password Changed',
      greeting: 'Hi {{name}},',
      intro: 'Your TempWorks password was just changed. If this was you, no further action is needed.',
      buttonLabel: 'Sign in',
      outro: 'If you did not change your password, contact your administrator immediately.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    passwordExpired: {
      subject: 'Your TempWorks Password Has Expired',
      heading: 'Password Expired',
      greeting: 'Hi {{name}},',
      intro: 'Your password has expired. Sign in to set a new one.',
      buttonLabel: 'Sign in',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    accountLocked: {
      subject: 'Your TempWorks Account Has Been Temporarily Locked',
      heading: 'Account Locked',
      greeting: 'Hi {{name}},',
      intro: 'For your security, your TempWorks account has been temporarily locked due to repeated failed sign-in attempts. The lock will lift automatically in 30 minutes.',
      outro: 'If this was not you, contact your administrator immediately.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    welcome: {
      subject: 'Welcome to TempWorks!',
      heading: 'Welcome',
      greeting: 'Hi {{name}},',
      intro: 'Welcome to TempWorks. Your account is now active and you can sign in to get started.',
      buttonLabel: 'Sign in',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    applicationConfirmation: {
      subject: 'Application Received – Reference {{reference}}',
      heading: 'Application Received',
      greeting: 'Hi {{name}},',
      intro: 'Thank you for applying. Your application has been received and our recruitment team will review it shortly. Your reference number is {{reference}}.',
      outro: 'We will contact you by email once your application has been reviewed.',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
    notification: {
      subject: '{{title}}',
      heading: '{{title}}',
      greeting: 'Hi {{name}},',
      signoff: '— The TempWorks Team',
      htmlDir: 'ltr',
    },
  },

  sk: {
    activation: {
      subject: 'Aktivujte svoj účet TempWorks',
      heading: 'Aktivujte svoj účet',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Vitajte v TempWorks. Kliknutím na tlačidlo nižšie aktivujete svoj účet a nastavíte si heslo.',
      buttonLabel: 'Aktivovať účet',
      fallbackLinkLabel: 'Alebo skopírujte túto URL do prehliadača:',
      outro: 'Tento odkaz vyprší o 24 hodín. Ak ste o aktiváciu nežiadali, ignorujte tento e-mail.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    passwordReset: {
      subject: 'Obnovte svoje heslo TempWorks',
      heading: 'Obnova hesla',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Prijali sme žiadosť o obnovenie vášho hesla. Kliknite na tlačidlo nižšie a nastavte si nové.',
      buttonLabel: 'Obnoviť heslo',
      fallbackLinkLabel: 'Alebo skopírujte túto URL do prehliadača:',
      outro: 'Tento odkaz vyprší o 1 hodinu. Ak ste o obnovenie nežiadali, môžete tento e-mail bezpečne ignorovať.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    passwordResetAdmin: {
      subject: 'Vaše heslo TempWorks bolo obnovené administrátorom',
      heading: 'Heslo obnovené administrátorom',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Administrátor inicioval obnovenie hesla pre váš účet. Kliknite na tlačidlo nižšie a nastavte si nové heslo.',
      buttonLabel: 'Nastaviť nové heslo',
      fallbackLinkLabel: 'Alebo skopírujte túto URL do prehliadača:',
      outro: 'Z bezpečnostných dôvodov kontaktujte svojho administrátora, ak ste tento e-mail neočakávali.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    twoFactor: {
      subject: 'Váš overovací kód TempWorks',
      heading: 'Overovací kód',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Použite kód nižšie na dokončenie prihlásenia. Kód vyprší o {{minutes}} minút.',
      outro: 'Ak ste sa nepokúsili prihlásiť, okamžite si zmeňte heslo.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    passwordChanged: {
      subject: 'Vaše heslo TempWorks bolo zmenené',
      heading: 'Heslo zmenené',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Vaše heslo TempWorks bolo práve zmenené. Ak ste to boli vy, nemusíte nič ďalšie robiť.',
      buttonLabel: 'Prihlásiť sa',
      outro: 'Ak ste heslo nemenili, okamžite kontaktujte svojho administrátora.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    passwordExpired: {
      subject: 'Vaše heslo TempWorks vypršalo',
      heading: 'Heslo vypršalo',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Vaše heslo vypršalo. Prihláste sa a nastavte si nové.',
      buttonLabel: 'Prihlásiť sa',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    accountLocked: {
      subject: 'Váš účet TempWorks bol dočasne uzamknutý',
      heading: 'Účet uzamknutý',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Z bezpečnostných dôvodov bol váš účet TempWorks dočasne uzamknutý kvôli opakovaným neúspešným pokusom o prihlásenie. Uzamknutie sa automaticky zruší o 30 minút.',
      outro: 'Ak ste to neboli vy, okamžite kontaktujte svojho administrátora.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    welcome: {
      subject: 'Vitajte v TempWorks!',
      heading: 'Vitajte',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Vitajte v TempWorks. Váš účet je teraz aktívny a môžete sa prihlásiť.',
      buttonLabel: 'Prihlásiť sa',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    applicationConfirmation: {
      subject: 'Žiadosť prijatá – referencia {{reference}}',
      heading: 'Žiadosť prijatá',
      greeting: 'Dobrý deň {{name}},',
      intro: 'Ďakujeme za vašu žiadosť. Bola prijatá a náš náborový tím ju čoskoro posúdi. Vaše referenčné číslo je {{reference}}.',
      outro: 'Po posúdení žiadosti vás budeme kontaktovať e-mailom.',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
    notification: {
      subject: '{{title}}',
      heading: '{{title}}',
      greeting: 'Dobrý deň {{name}},',
      signoff: '— Tím TempWorks',
      htmlDir: 'ltr',
    },
  },

  de: {
    activation: {
      subject: 'Aktivieren Sie Ihr TempWorks-Konto',
      heading: 'Konto aktivieren',
      greeting: 'Hallo {{name}},',
      intro: 'Willkommen bei TempWorks. Klicken Sie auf die Schaltfläche, um Ihr Konto zu aktivieren und ein Passwort festzulegen.',
      buttonLabel: 'Konto aktivieren',
      fallbackLinkLabel: 'Oder fügen Sie diese URL in Ihren Browser ein:',
      outro: 'Dieser Link läuft in 24 Stunden ab. Falls Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    passwordReset: {
      subject: 'Setzen Sie Ihr TempWorks-Passwort zurück',
      heading: 'Passwort zurücksetzen',
      greeting: 'Hallo {{name}},',
      intro: 'Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten. Klicken Sie auf die Schaltfläche, um ein neues festzulegen.',
      buttonLabel: 'Passwort zurücksetzen',
      fallbackLinkLabel: 'Oder fügen Sie diese URL in Ihren Browser ein:',
      outro: 'Dieser Link läuft in 1 Stunde ab. Falls Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    passwordResetAdmin: {
      subject: 'Ihr TempWorks-Passwort wurde von einem Administrator zurückgesetzt',
      heading: 'Passwort vom Administrator zurückgesetzt',
      greeting: 'Hallo {{name}},',
      intro: 'Ein Administrator hat das Zurücksetzen Ihres Passworts veranlasst. Klicken Sie auf die Schaltfläche, um ein neues Passwort festzulegen.',
      buttonLabel: 'Neues Passwort festlegen',
      fallbackLinkLabel: 'Oder fügen Sie diese URL in Ihren Browser ein:',
      outro: 'Aus Sicherheitsgründen wenden Sie sich bitte an Ihren Administrator, falls Sie diese E-Mail nicht erwartet haben.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    twoFactor: {
      subject: 'Ihr TempWorks-Bestätigungscode',
      heading: 'Bestätigungscode',
      greeting: 'Hallo {{name}},',
      intro: 'Verwenden Sie den untenstehenden Code, um die Anmeldung abzuschließen. Der Code läuft in {{minutes}} Minuten ab.',
      outro: 'Falls Sie sich nicht angemeldet haben, ändern Sie umgehend Ihr Passwort.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    passwordChanged: {
      subject: 'Ihr TempWorks-Passwort wurde geändert',
      heading: 'Passwort geändert',
      greeting: 'Hallo {{name}},',
      intro: 'Ihr TempWorks-Passwort wurde gerade geändert. Falls Sie das selbst getan haben, ist nichts weiter zu tun.',
      buttonLabel: 'Anmelden',
      outro: 'Falls Sie Ihr Passwort nicht geändert haben, kontaktieren Sie sofort Ihren Administrator.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    passwordExpired: {
      subject: 'Ihr TempWorks-Passwort ist abgelaufen',
      heading: 'Passwort abgelaufen',
      greeting: 'Hallo {{name}},',
      intro: 'Ihr Passwort ist abgelaufen. Melden Sie sich an, um ein neues festzulegen.',
      buttonLabel: 'Anmelden',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    accountLocked: {
      subject: 'Ihr TempWorks-Konto wurde vorübergehend gesperrt',
      heading: 'Konto gesperrt',
      greeting: 'Hallo {{name}},',
      intro: 'Aus Sicherheitsgründen wurde Ihr TempWorks-Konto wegen mehrerer fehlgeschlagener Anmeldeversuche vorübergehend gesperrt. Die Sperre wird in 30 Minuten automatisch aufgehoben.',
      outro: 'Falls das nicht Sie waren, kontaktieren Sie sofort Ihren Administrator.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    welcome: {
      subject: 'Willkommen bei TempWorks!',
      heading: 'Willkommen',
      greeting: 'Hallo {{name}},',
      intro: 'Willkommen bei TempWorks. Ihr Konto ist jetzt aktiv und Sie können sich anmelden.',
      buttonLabel: 'Anmelden',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    applicationConfirmation: {
      subject: 'Bewerbung erhalten – Referenz {{reference}}',
      heading: 'Bewerbung erhalten',
      greeting: 'Hallo {{name}},',
      intro: 'Vielen Dank für Ihre Bewerbung. Sie wurde empfangen und unser Recruiting-Team wird sie in Kürze prüfen. Ihre Referenznummer ist {{reference}}.',
      outro: 'Wir kontaktieren Sie per E-Mail, sobald Ihre Bewerbung geprüft wurde.',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
    notification: {
      subject: '{{title}}',
      heading: '{{title}}',
      greeting: 'Hallo {{name}},',
      signoff: '— Das TempWorks-Team',
      htmlDir: 'ltr',
    },
  },

  ru: {
    activation: {
      subject: 'Активируйте свой аккаунт TempWorks',
      heading: 'Активация аккаунта',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Добро пожаловать в TempWorks. Нажмите на кнопку ниже, чтобы активировать аккаунт и задать пароль.',
      buttonLabel: 'Активировать аккаунт',
      fallbackLinkLabel: 'Или вставьте эту ссылку в браузер:',
      outro: 'Срок действия ссылки — 24 часа. Если вы не запрашивали активацию, проигнорируйте это письмо.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    passwordReset: {
      subject: 'Сброс пароля TempWorks',
      heading: 'Сброс пароля',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Мы получили запрос на сброс вашего пароля. Нажмите кнопку ниже, чтобы выбрать новый.',
      buttonLabel: 'Сбросить пароль',
      fallbackLinkLabel: 'Или вставьте эту ссылку в браузер:',
      outro: 'Срок действия — 1 час. Если вы не запрашивали сброс, проигнорируйте это письмо.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    passwordResetAdmin: {
      subject: 'Ваш пароль TempWorks был сброшен администратором',
      heading: 'Пароль сброшен администратором',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Администратор инициировал сброс пароля для вашего аккаунта. Нажмите кнопку ниже, чтобы задать новый пароль.',
      buttonLabel: 'Задать новый пароль',
      fallbackLinkLabel: 'Или вставьте эту ссылку в браузер:',
      outro: 'В целях безопасности обратитесь к администратору, если не ожидали этого письма.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    twoFactor: {
      subject: 'Код подтверждения TempWorks',
      heading: 'Код подтверждения',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Используйте код ниже, чтобы завершить вход. Срок действия кода — {{minutes}} минут.',
      outro: 'Если вы не пытались войти, немедленно смените пароль.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    passwordChanged: {
      subject: 'Ваш пароль TempWorks был изменён',
      heading: 'Пароль изменён',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Ваш пароль TempWorks был только что изменён. Если это были вы — никаких действий не требуется.',
      buttonLabel: 'Войти',
      outro: 'Если вы не меняли пароль, немедленно свяжитесь с администратором.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    passwordExpired: {
      subject: 'Срок действия вашего пароля TempWorks истёк',
      heading: 'Срок действия пароля истёк',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Срок действия вашего пароля истёк. Войдите, чтобы задать новый.',
      buttonLabel: 'Войти',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    accountLocked: {
      subject: 'Ваш аккаунт TempWorks временно заблокирован',
      heading: 'Аккаунт заблокирован',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'В целях безопасности ваш аккаунт TempWorks временно заблокирован из-за многократных неудачных попыток входа. Блокировка снимется автоматически через 30 минут.',
      outro: 'Если это были не вы, немедленно свяжитесь с администратором.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    welcome: {
      subject: 'Добро пожаловать в TempWorks!',
      heading: 'Добро пожаловать',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Добро пожаловать в TempWorks. Ваш аккаунт активен — можно входить.',
      buttonLabel: 'Войти',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    applicationConfirmation: {
      subject: 'Заявка получена — номер {{reference}}',
      heading: 'Заявка получена',
      greeting: 'Здравствуйте, {{name}}!',
      intro: 'Спасибо за вашу заявку. Она получена и наша команда рассмотрит её в ближайшее время. Ваш номер заявки — {{reference}}.',
      outro: 'Мы свяжемся с вами по электронной почте после рассмотрения заявки.',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
    notification: {
      subject: '{{title}}',
      heading: '{{title}}',
      greeting: 'Здравствуйте, {{name}}!',
      signoff: '— Команда TempWorks',
      htmlDir: 'ltr',
    },
  },

  ar: {
    activation: {
      subject: 'فعّل حسابك في TempWorks',
      heading: 'تفعيل الحساب',
      greeting: 'مرحبًا {{name}},',
      intro: 'مرحبًا بك في TempWorks. اضغط على الزر أدناه لتفعيل حسابك وتعيين كلمة المرور.',
      buttonLabel: 'تفعيل الحساب',
      fallbackLinkLabel: 'أو الصق هذا الرابط في متصفحك:',
      outro: 'تنتهي صلاحية هذا الرابط خلال 24 ساعة. إذا لم تطلب التفعيل، تجاهل هذه الرسالة.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    passwordReset: {
      subject: 'إعادة تعيين كلمة مرور TempWorks',
      heading: 'إعادة تعيين كلمة المرور',
      greeting: 'مرحبًا {{name}},',
      intro: 'استلمنا طلبًا لإعادة تعيين كلمة المرور. اضغط على الزر أدناه لاختيار كلمة جديدة.',
      buttonLabel: 'إعادة تعيين كلمة المرور',
      fallbackLinkLabel: 'أو الصق هذا الرابط في متصفحك:',
      outro: 'تنتهي صلاحية هذا الرابط خلال ساعة. إذا لم تطلب إعادة تعيين، يمكنك تجاهل هذه الرسالة.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    passwordResetAdmin: {
      subject: 'تم إعادة تعيين كلمة مرور TempWorks بواسطة المسؤول',
      heading: 'إعادة تعيين كلمة المرور بواسطة المسؤول',
      greeting: 'مرحبًا {{name}},',
      intro: 'بدأ مسؤول النظام عملية إعادة تعيين كلمة المرور لحسابك. اضغط على الزر أدناه لتعيين كلمة جديدة.',
      buttonLabel: 'تعيين كلمة جديدة',
      fallbackLinkLabel: 'أو الصق هذا الرابط في متصفحك:',
      outro: 'لأسباب أمنية، تواصل مع المسؤول إذا لم تكن تتوقع هذه الرسالة.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    twoFactor: {
      subject: 'رمز التحقق الخاص بك في TempWorks',
      heading: 'رمز التحقق',
      greeting: 'مرحبًا {{name}},',
      intro: 'استخدم الرمز أدناه لإكمال تسجيل الدخول. تنتهي صلاحية الرمز خلال {{minutes}} دقائق.',
      outro: 'إذا لم تحاول تسجيل الدخول، غيّر كلمة المرور فورًا.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    passwordChanged: {
      subject: 'تم تغيير كلمة مرور TempWorks',
      heading: 'تم تغيير كلمة المرور',
      greeting: 'مرحبًا {{name}},',
      intro: 'تم تغيير كلمة مرور TempWorks للتو. إذا كنت أنت، فلا حاجة لأي إجراء آخر.',
      buttonLabel: 'تسجيل الدخول',
      outro: 'إذا لم تقم بتغيير كلمة المرور، تواصل مع المسؤول فورًا.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    passwordExpired: {
      subject: 'انتهت صلاحية كلمة مرور TempWorks',
      heading: 'انتهت صلاحية كلمة المرور',
      greeting: 'مرحبًا {{name}},',
      intro: 'انتهت صلاحية كلمة المرور. سجّل الدخول لتعيين كلمة جديدة.',
      buttonLabel: 'تسجيل الدخول',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    accountLocked: {
      subject: 'تم قفل حساب TempWorks مؤقتًا',
      heading: 'الحساب مقفل',
      greeting: 'مرحبًا {{name}},',
      intro: 'لأسباب أمنية، تم قفل حسابك مؤقتًا بسبب محاولات تسجيل دخول فاشلة متكررة. سيُرفع القفل تلقائيًا خلال 30 دقيقة.',
      outro: 'إذا لم تكن أنت، تواصل مع المسؤول فورًا.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    welcome: {
      subject: 'مرحبًا بك في TempWorks!',
      heading: 'مرحبًا',
      greeting: 'مرحبًا {{name}},',
      intro: 'مرحبًا بك في TempWorks. حسابك أصبح نشطًا ويمكنك تسجيل الدخول.',
      buttonLabel: 'تسجيل الدخول',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    applicationConfirmation: {
      subject: 'تم استلام الطلب – المرجع {{reference}}',
      heading: 'تم استلام الطلب',
      greeting: 'مرحبًا {{name}},',
      intro: 'شكرًا لتقديمك. تم استلام طلبك وسيراجعه فريق التوظيف قريبًا. رقمك المرجعي هو {{reference}}.',
      outro: 'سنتواصل معك بالبريد الإلكتروني بعد مراجعة الطلب.',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
    notification: {
      subject: '{{title}}',
      heading: '{{title}}',
      greeting: 'مرحبًا {{name}},',
      signoff: '— فريق TempWorks',
      htmlDir: 'rtl',
    },
  },

  tr: {
    activation: {
      subject: 'TempWorks Hesabınızı Etkinleştirin',
      heading: 'Hesabı Etkinleştir',
      greeting: 'Merhaba {{name}},',
      intro: "TempWorks'e hoş geldiniz. Hesabınızı etkinleştirmek ve şifrenizi belirlemek için aşağıdaki butona tıklayın.",
      buttonLabel: 'Hesabı Etkinleştir',
      fallbackLinkLabel: 'Veya bu URL\'yi tarayıcınıza yapıştırın:',
      outro: 'Bu bağlantı 24 saat içinde sona erer. Eğer bunu siz talep etmediyseniz, lütfen bu e-postayı yok sayın.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    passwordReset: {
      subject: 'TempWorks Şifrenizi Sıfırlayın',
      heading: 'Şifre Sıfırlama',
      greeting: 'Merhaba {{name}},',
      intro: 'Şifrenizi sıfırlama isteği aldık. Yeni bir şifre belirlemek için aşağıdaki butona tıklayın.',
      buttonLabel: 'Şifreyi Sıfırla',
      fallbackLinkLabel: 'Veya bu URL\'yi tarayıcınıza yapıştırın:',
      outro: 'Bu bağlantı 1 saat içinde sona erer. Eğer talep etmediyseniz bu e-postayı yok sayabilirsiniz.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    passwordResetAdmin: {
      subject: 'TempWorks Şifreniz Bir Yönetici Tarafından Sıfırlandı',
      heading: 'Şifre Yönetici Tarafından Sıfırlandı',
      greeting: 'Merhaba {{name}},',
      intro: 'Bir yönetici hesabınız için şifre sıfırlama başlattı. Yeni bir şifre belirlemek için aşağıdaki butona tıklayın.',
      buttonLabel: 'Yeni Şifre Belirle',
      fallbackLinkLabel: 'Veya bu URL\'yi tarayıcınıza yapıştırın:',
      outro: 'Güvenlik için, bu e-postayı beklemiyorsanız yöneticinizle iletişime geçin.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    twoFactor: {
      subject: 'TempWorks Doğrulama Kodunuz',
      heading: 'Doğrulama Kodu',
      greeting: 'Merhaba {{name}},',
      intro: 'Oturum açmayı tamamlamak için aşağıdaki kodu kullanın. Kodun süresi {{minutes}} dakika.',
      outro: 'Eğer oturum açmaya çalışmadıysanız, hemen şifrenizi değiştirin.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    passwordChanged: {
      subject: 'TempWorks Şifreniz Değiştirildi',
      heading: 'Şifre Değiştirildi',
      greeting: 'Merhaba {{name}},',
      intro: 'TempWorks şifreniz az önce değiştirildi. Bunu siz yaptıysanız, başka bir işleminize gerek yok.',
      buttonLabel: 'Oturum Aç',
      outro: 'Şifrenizi siz değiştirmediyseniz, hemen yöneticinizle iletişime geçin.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    passwordExpired: {
      subject: 'TempWorks Şifrenizin Süresi Doldu',
      heading: 'Şifre Süresi Doldu',
      greeting: 'Merhaba {{name}},',
      intro: 'Şifrenizin süresi doldu. Yeni bir şifre belirlemek için oturum açın.',
      buttonLabel: 'Oturum Aç',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    accountLocked: {
      subject: 'TempWorks Hesabınız Geçici Olarak Kilitlendi',
      heading: 'Hesap Kilitlendi',
      greeting: 'Merhaba {{name}},',
      intro: 'Güvenliğiniz için, tekrarlayan başarısız oturum açma denemeleri nedeniyle TempWorks hesabınız geçici olarak kilitlendi. Kilit 30 dakika içinde otomatik olarak kalkar.',
      outro: 'Bu siz değilseniz, hemen yöneticinizle iletişime geçin.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    welcome: {
      subject: "TempWorks'e Hoş Geldiniz!",
      heading: 'Hoş Geldiniz',
      greeting: 'Merhaba {{name}},',
      intro: "TempWorks'e hoş geldiniz. Hesabınız artık aktif ve giriş yapabilirsiniz.",
      buttonLabel: 'Oturum Aç',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    applicationConfirmation: {
      subject: 'Başvuru Alındı – Referans {{reference}}',
      heading: 'Başvuru Alındı',
      greeting: 'Merhaba {{name}},',
      intro: 'Başvurduğunuz için teşekkürler. Başvurunuz alındı ve işe alım ekibimiz kısa süre içinde inceleyecek. Referans numaranız {{reference}}.',
      outro: 'Başvurunuz incelendikten sonra size e-posta ile ulaşacağız.',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
    notification: {
      subject: '{{title}}',
      heading: '{{title}}',
      greeting: 'Merhaba {{name}},',
      signoff: '— TempWorks Ekibi',
      htmlDir: 'ltr',
    },
  },
};

export function tEmail(
  locale: string | null | undefined,
  template: TemplateKey,
): EmailTemplateStrings {
  const lc = (locale ?? FALLBACK).toLowerCase();
  const resolved = (SUPPORTED.includes(lc as EmailLocale) ? (lc as EmailLocale) : FALLBACK);
  return EMAIL_TRANSLATIONS[resolved][template] ?? EMAIL_TRANSLATIONS[FALLBACK][template];
}

export function interpolate(text: string, vars: Record<string, string | number | undefined>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

export type { EmailTemplateStrings, EmailLocale, TemplateKey };
export { SUPPORTED as SUPPORTED_EMAIL_LOCALES, FALLBACK as FALLBACK_EMAIL_LOCALE };
