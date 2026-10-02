!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  Var trialDesktopShortcut
  Var trialShortcutCheckbox

  !define MUI_FINISHPAGE_RUN_TEXT "تشغيل نظام إدارة الحسابات والمتجر"

  !macro customInit
    StrCpy $trialDesktopShortcut ${BST_CHECKED}
  !macroend

  !macro customWelcomePage
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !macro customPageAfterChangeDir
    Page custom trialShortcutPage trialShortcutLeave
  !macroend

  Function trialShortcutPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 22u "اختر ما إذا كنت تريد اختصاراً على سطح المكتب."
    Pop $0
    ${NSD_CreateCheckbox} 0 32u 100% 18u "إنشاء اختصار على سطح المكتب"
    Pop $trialShortcutCheckbox
    ${NSD_SetState} $trialShortcutCheckbox $trialDesktopShortcut
    nsDialogs::Show
  FunctionEnd

  Function trialShortcutLeave
    ${NSD_GetState} $trialShortcutCheckbox $trialDesktopShortcut
  FunctionEnd

  !macro customInstall
    ${If} $trialDesktopShortcut != ${BST_CHECKED}
      Delete "$newDesktopLink"
    ${EndIf}
  !macroend
!endif
