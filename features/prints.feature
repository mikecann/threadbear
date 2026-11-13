Feature: Diagram Prints
  As someone keeping diagrams with a project or a thread
  I want to edit their source and keep the previous versions
  So the diagram stays useful after the reply that made it

  # The demo-runner driver does not seed local Prints yet. These flows
  # are checked with an isolated dev runner until that driver supports them.
  @prints.diagram @manual @gpui-pending
  Scenario: Edit a diagram's source and keep the preceding version
    Given a diagram Print called "Task flow" contains Mermaid source
    When I choose Edit Text from that Print's menu
    Then the editor shows its Mermaid source
    When I change the source and save it
    Then the diagram redraws as a new version marked edited by you
    And its preceding version can still be opened and restored

  @prints.diagram @manual @gpui-pending
  Scenario: A malformed source edit keeps the current diagram
    Given a diagram Print called "Task flow" has a saved version
    When I save malformed Mermaid source in its Edit Text editor
    Then an error explains that the diagram could not be rendered
    And the current diagram and its version remain unchanged

  @prints.diagram @manual @gpui-pending
  Scenario: A diagram remains accessible without a project
    Given a diagram Print was created in a thread with no project
    When I reopen its card in that thread
    Then I can open the diagram and edit its source
    And assigning it to a project lists the same Print there

  @prints.whenasked @manual @gpui-pending
  Scenario: Only make Prints when I ask holds back a Print nobody asked for
    Given Prints is on and "Only make Prints when I ask" is on in Settings
    When a thread goes to make a Print after a message that asks for none
    Then an approval card asks "Make the print" with its title first
    When I choose No on that card
    Then no Print is made and the thread is told I said no
    When I ask a thread to "make a chart of this data"
    Then it makes the Print without a card

  @prints.pane @manual @gpui-pending
  Scenario: A Print opened from its card follows new versions in the side pane
    Given a reply in a thread shows a Print's card at version 1
    When I click Open on the card
    Then the Print opens in the thread's side pane
    When the thread saves version 2 of that Print
    Then the side pane shows version 2 without another click

  @prints.list @manual @gpui-pending
  Scenario: Prints show in Highlights and on the rail with their projects
    Given a thread made a Print in the project "Demo Shop" and one in no project
    When I open that thread
    Then its Highlights list both under Prints, one saying "Demo Shop" and one "No project"
    And the rail shows a Prints button under Files with a count of 2
    When I click the Prints button
    Then it lists every Print with its projects
    When I click "Launch notes"
    Then it opens beside the thread

  @prints.todo @manual @gpui-pending
  Scenario: Tick a todo list and move a card on a board
    Given a thread made a todo list Print "Launch checklist" and a board Print "PR board"
    When I open "Launch checklist" beside the thread and click "Write the tests"
    Then it is ticked in a new version and the count of done items goes up
    When I open "PR board" and click a card's arrow to the next column
    Then the card is in that column in a new version
    And clicking in an older version says it changed and changes nothing
