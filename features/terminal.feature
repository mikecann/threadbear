Feature: The Terminal
  As someone working with an agent in a folder
  I want a real shell in that folder under the thread
  So I can look at its work and run what only I can, without leaving the app

  # A shell here always runs in a temp folder the scenario makes: the demo
  # threads' own folders are Mike's, and a shell never starts in anyone's.
  #
  # @windows-pending: what these type is a POSIX shell's (printf, seq, tput,
  # trap, /bin/bash), and Windows' Terminal runs PowerShell; and there a
  # command from a reply is always copied, never typed, as only a Unix can
  # tell its shell is the one at the prompt (terminal.rs, shell_in_front).

  Background:
    Given the app is connected to a runner with the demo threads

  # GPUI's scripted command clicks the actual grid cell; the frozen Swift
  # driver has no matching command (its view already follows links).
  @terminal.panel @windows-pending @swift-pending
  Scenario: A printed Terminal link opens through the app's gate
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "printf 'https://example.com/terminal\n'" and press Return in the Terminal
    Then the Terminal shows the line "https://example.com/terminal"
    When I follow the Terminal link "https://example.com/terminal"
    Then "https://example.com/terminal" was opened through the app

  @terminal.panel @windows-pending @swift-pending
  Scenario: A labelled Terminal hyperlink follows its address
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "printf '\033]8;;https://example.com/labelled\033\\Open the page\033]8;;\033\\\n'" and press Return in the Terminal
    Then the Terminal shows the line "Open the page"
    When I follow the Terminal link "Open the page"
    Then "https://example.com/labelled" was opened through the app

  @terminal.panel @windows-pending @swift-pending
  Scenario: A Terminal hyperlink cannot run a program without asking
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And the Terminal prints a link to a program in its folder
    And I follow the Terminal link "Run the program"
    Then nothing was opened in another app
    And the Terminal link's program did not run

  @terminal.panel
  Scenario: ⌘J brings up a shell in the thread's folder, with the keyboard
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    Then the Terminal is showing a shell in the thread's folder
    And the Terminal has the keyboard
    When I type "pwd" and press Return in the Terminal
    Then the Terminal shows the thread's folder

  @terminal.panel
  Scenario: ⌘J again puts it away, and the shell keeps running
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I press ⌘J
    Then the Terminal is put away
    And the thread's shell is still running

  @terminal.panel @windows-pending
  Scenario: What a program prints shows in the Terminal
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "printf '\033[31mred\033[0m and plain\n'" and press Return in the Terminal
    Then the Terminal shows the line "red and plain"

  @terminal.panel @windows-pending
  Scenario: What's scrolled off the top can be scrolled back to
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "seq 1 400" and press Return in the Terminal
    Then the Terminal shows the line "400"
    When I scroll the Terminal back 300 lines
    Then the Terminal shows earlier lines and not the line "400"

  @terminal.panel
  Scenario: Text copies out of the Terminal and pastes into it
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "echo copy-me" and press Return in the Terminal
    Then the Terminal shows the line "copy-me"
    When I select everything in the Terminal and copy it
    Then the clipboard holds "copy-me" among other lines
    When I paste "echo pasted-in" into the Terminal and press Return
    Then the Terminal shows the line "pasted-in"

  # macOS's own bash never asks for pastes to be marked, so each line break
  # would be Return. A newer bash does (Linux's), unless told not to, which
  # macOS's doesn't know and shrugs off. A scripted app answers the question
  # with Cancel. Linux has no question of the app's own yet, so there it
  # doesn't paste rather than asking (alert.rs): this would pass without
  # asking anything.
  @terminal.panel @windows-pending @linux-pending
  Scenario: Pasting lines that would each run asks first
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "/bin/bash --norc --noprofile" and press Return in the Terminal
    And I type "bind 'set enable-bracketed-paste off'; echo told-bash" and press Return in the Terminal
    Then the Terminal shows the line "told-bash"
    And the shell in the Terminal doesn't mark pastes
    When I paste the lines "echo pasted-one" and "echo pasted-two" into the Terminal
    Then the Terminal doesn't show the line "pasted-one"
    And the Terminal's prompt doesn't have "echo pasted-one"

  # A text expander's snippet or dictated paragraphs come from the input
  # method in one go, and a line break in them would be Return.
  @terminal.panel @windows-pending
  Scenario: Text an input method puts in all at once is pasted, not typed
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    Then the shell in the Terminal is at its prompt
    When an input method puts "echo from-a-snippet" and a line break in the Terminal at once
    Then the Terminal's prompt has "echo from-a-snippet" on it
    And the Terminal doesn't show the line "from-a-snippet"

  @terminal.panel @windows-pending
  Scenario: The shell is as wide as the panel
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I note how many columns the Terminal has
    And the window is made 300 points wider
    Then the Terminal has more columns than before
    When I type "tput cols" and press Return in the Terminal
    Then the Terminal shows its own number of columns

  @terminal.panel
  Scenario: A thread whose folder isn't on this Mac says where its Terminal is
    When I open the thread "Export last quarter's invoices as CSV"
    And I bring up the Terminal without starting a shell
    Then the Terminal says "This thread's folder isn't on this Mac any more, so this terminal is in your home folder."
    And the Terminal offers to start a shell

  @terminal.lifecycle
  Scenario: A shell starts only when one's asked for
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I bring up the Terminal without starting a shell
    Then the Terminal offers to start a shell
    And no shell is running
    When I start a shell from the empty Terminal
    Then the Terminal is showing a shell in the thread's folder

  @terminal.lifecycle
  Scenario: Each thread keeps its own shell while I look at others
    Given the thread "Rename the Settings tabs" works in a folder of its own
    And the thread "Tidy the imports in the uploader" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I open the thread "Tidy the imports in the uploader"
    Then the Terminal offers to start a shell
    When I open the thread "Rename the Settings tabs"
    Then the Terminal is showing a shell in the thread's folder
    And 1 shell is running

  @terminal.lifecycle
  Scenario: Archiving a thread stops its shell
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    Then the thread's shell is still running
    When I archive the open thread
    Then the shell of "Rename the Settings tabs" has stopped

  # SIGHUP alone left such a shell running for good, still in the folder,
  # as the pty waited for it to end before closing (Codex's review, 11 Nov).
  @terminal.lifecycle @windows-pending
  Scenario: Archiving a thread stops its shell even when it ignores the hang-up
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "trap '' HUP; echo $$ > shell.pid; echo ready" and press Return in the Terminal
    Then the Terminal shows the line "ready"
    When I archive the open thread
    Then the shell that wrote "shell.pid" in the folder of "Rename the Settings tabs" has ended

  # Nor one that ignores SIGTERM too and never reads its terminal, which
  # closing the pty with the app doesn't reach.
  @terminal.lifecycle @windows-pending
  Scenario: Quitting stops a shell that ignores the hang-up
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "trap '' HUP TERM; echo $$ > shell.pid; echo ready; while :; do :; done" and press Return in the Terminal
    Then the Terminal shows the line "ready"
    When the app quits
    Then the shell that wrote "shell.pid" in the folder of "Rename the Settings tabs" has ended

  # Archiving starts ending it, two seconds a step; quitting in the meantime
  # mustn't leave it to a thread that goes with the app.
  @terminal.lifecycle @windows-pending
  Scenario: Quitting just after archiving still stops a shell that ignores the hang-up
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "trap '' HUP TERM; echo $$ > shell.pid; echo ready; while :; do :; done" and press Return in the Terminal
    Then the Terminal shows the line "ready"
    When I archive the open thread
    Then the shell of "Rename the Settings tabs" has stopped
    When the app quits
    Then the shell that wrote "shell.pid" in the folder of "Rename the Settings tabs" has ended

  @terminal.lifecycle
  Scenario: A shell that has exited can be started again
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "exit" and press Return in the Terminal
    Then the Terminal says the shell has exited
    When I press New Shell in the Terminal
    Then the Terminal is showing a shell in the thread's folder

  @terminal.putcommand @windows-pending
  Scenario: A shell block's command goes to the Terminal's prompt, and only Return runs it
    Given the thread "Rename the Settings tabs" works in a folder of its own
    And the agent's last reply in "Rename the Settings tabs" holds a bash block "echo from-the-reply"
    When I open the thread "Rename the Settings tabs"
    Then the reply offers to put "echo from-the-reply" in the Terminal
    When I put "echo from-the-reply" in the Terminal from its block
    Then the Terminal's prompt has "echo from-the-reply" waiting for Return
    And the Terminal doesn't show the line "from-the-reply"
    When I press Return in the Terminal
    Then the Terminal shows the line "from-the-reply"

  # Not typed in place of the first: clearing that would mean sending keys
  # (^U) a shell can have bound to anything, Return included.
  @terminal.putcommand @windows-pending
  Scenario: Another block's command is copied while one waits unrun
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I put "echo first-one" in the Terminal from its block
    Then the Terminal's prompt has "echo first-one" waiting for Return
    When I put "echo second-one" in the Terminal from its block
    Then "echo second-one" is copied instead
    And the Terminal's prompt has "echo first-one" waiting for Return
    And the Terminal's prompt doesn't have "echo second-one"

  # `exec` keeps the shell's process and its hold on the terminal, so only the
  # program it's running now says it isn't the shell (`exec ssh` would type
  # into another machine). cat with pastes marked looks like a prompt otherwise.
  # With job control off, a program the shell runs stays in the shell's own
  # group, so the group having the terminal doesn't say the shell is the one
  # reading it (`ssh -tt` there would get the command). `set +m` turns job
  # control off in zsh and bash alike (zsh's `unsetopt monitor` is bash's
  # "command not found", which left job control on there).
  @terminal.putcommand @windows-pending
  Scenario: A program in the shell's own group counts as busy
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "set +m; printf '\033[?2004hcat-ready\n'; /bin/cat" and press Return in the Terminal
    Then the Terminal shows the line "cat-ready"
    When I put "echo not-in-cat" in the Terminal from its block
    Then "echo not-in-cat" is copied instead

  @terminal.putcommand @windows-pending
  Scenario: A shell that execs another program counts as busy
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "printf '\033[?2004hcat-ready\n'; exec /bin/cat" and press Return in the Terminal
    Then the Terminal shows the line "cat-ready"
    When I put "echo not-in-there" in the Terminal from its block
    Then "echo not-in-there" is copied instead

  @terminal.putcommand
  Scenario: A busy Terminal gets the command copied instead of typed
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "sleep 30" and press Return in the Terminal
    And I put "echo not-now" in the Terminal from its block
    Then "echo not-now" is copied instead
    And the Terminal's prompt doesn't have "echo not-now"

  @terminal.putcommand
  Scenario: A thread whose folder isn't on this Mac only offers to copy its blocks
    Given the agent's last reply in "Export last quarter's invoices as CSV" holds a bash block "make report"
    When I open the thread "Export last quarter's invoices as CSV"
    Then the reply only offers to copy "make report"

  # The frozen Swift automation lacks the tab and hover commands used below.
  @terminal.tabs @swift-pending
  Scenario: Separate shells keep their screens when switching tabs
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "echo first-shell" and press Return in the Terminal
    Then the Terminal shows the line "first-shell"
    When I rename the current Terminal tab to "First"
    And I add a Terminal tab
    And I type "echo second-shell" and press Return in the Terminal
    Then the Terminal shows the line "second-shell"
    When I rename the current Terminal tab to "Second"
    And I choose the Terminal tab "First"
    Then the Terminal shows the line "first-shell"
    When I choose the Terminal tab "Second"
    And I type "exit" and press Return in the Terminal
    Then the Terminal has 1 tab
    And the Terminal shows the line "first-shell"

  @terminal.tabs @swift-pending
  Scenario: A tab can be renamed from its menu and closed
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I rename the current Terminal tab to "Dev server"
    Then the Terminal tab menu for "Dev server" offers "Rename…" and "Use the Shell's Name"
    When I rename the Terminal tab "Dev server" from its menu to "Server"
    And I add a Terminal tab
    And I rename the current Terminal tab to "Scratch"
    And I close the Terminal tab "Scratch" from its menu
    Then the Terminal has 1 tab
    And the Terminal tab "Server" is selected

  @terminal.linkhover @windows-pending @swift-pending
  Scenario: Pointing at a printed web address highlights the link
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "printf 'https://example.com/terminal\n'" and press Return in the Terminal
    Then the Terminal shows the line "https://example.com/terminal"
    When I point at the Terminal words "https://example.com/terminal"
    Then the Terminal highlights the web address "https://example.com/terminal"

  @terminal.panel
  Scenario: Closing the Terminal keeps the conversation visible
    When I open the thread "Make uploads resume after a crash"
    And I press ⌘J
    And I press ⌘J
    Then the Terminal is put away
    And the transcript shows my message "Great. Clear out the old build folders too"

  @terminal.panel @rail.right
  Scenario: The optional rail button opens the same terminal as the keyboard
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    Then the right rail has no "Terminal" button
    When I open Settings on "general"
    And I press "Add a Terminal button to the rail" in Settings
    And I close the slash settings window
    Then the right rail has a "Terminal" button
    When I click "Terminal" in the right rail
    Then the Terminal is showing a shell in the thread's folder
    And the "Terminal" button in the right rail is lit
    When I type "printf 'rail-kept-shell\n'" and press Return in the Terminal
    Then the Terminal shows the line "rail-kept-shell"
    When I press ⌘J
    And I click "Terminal" in the right rail
    Then the Terminal shows the line "rail-kept-shell"

  # Terminal.app's keys and comforts, where Threadbear's own keys don't
  # already have them (⌘K is Open Anything, so ⌘L clears). The GPUI app's;
  # the frozen Swift app doesn't get new features.
  @terminal.mackeys @swift-pending @windows-pending @linux-pending
  Scenario: ⌘← and ⌘→ go to the start and end of the line, and ⌘⌫ deletes it
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "echo middle" in the Terminal
    And I press "cmd-left" in the Terminal
    And I type "X" in the Terminal
    And I press "cmd-right" in the Terminal
    And I type "Y" in the Terminal
    Then the Terminal's prompt has "Xecho middleY" on it
    When I press "cmd-backspace" in the Terminal
    And I type "echo fresh" and press Return in the Terminal
    Then the Terminal shows the line "fresh"

  @terminal.mackeys @swift-pending @windows-pending @linux-pending
  Scenario: ⌘L clears everything above the prompt
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I type "echo old-output" and press Return in the Terminal
    Then the Terminal shows the line "old-output"
    When I type "echo kept" in the Terminal
    And I press "cmd-l" in the Terminal
    Then the Terminal doesn't show the line "old-output"
    And the Terminal's prompt has "echo kept" on it

  @terminal.mackeys @swift-pending @windows-pending @linux-pending
  Scenario: ⌘F finds words in the Terminal and counts them
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    # The word is split on the command line, so only what it prints has it,
    # and Find waits for that to be drawn.
    And I type "printf 'nee%sdle\nhay\nnee%sdle\n' '' ''" and press Return in the Terminal
    Then the Terminal shows the line "hay"
    When I find "needle" in the Terminal
    Then the Terminal's Find says "2 of 2"
    When I press "enter" in the Terminal's Find
    Then the Terminal's Find says "1 of 2"
    And the Terminal has "needle" selected

  @terminal.mackeys @swift-pending @windows-pending @linux-pending
  Scenario: ⌘T opens another shell and ⌃Tab goes between them
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I press "cmd-t" in the Terminal
    Then the Terminal has 2 tabs
    And the Terminal tab "Terminal 2" is selected
    When I press "ctrl-tab" in the Terminal
    Then the Terminal tab "Terminal 1" is selected

  @terminal.mackeys @swift-pending @windows-pending @linux-pending
  Scenario: The bell in a tab I'm not looking at puts a dot on it
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When I open the thread "Rename the Settings tabs"
    And I press ⌘J
    And I press "cmd-t" in the Terminal
    And I type "sleep 1; printf '\a'" and press Return in the Terminal
    And I press "ctrl-tab" in the Terminal
    Then a Terminal tab has rung its bell
