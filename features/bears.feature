Feature: Bear tiles in the sidebar
  As someone with named bears
  I want each bear's threads to show its own icon and colour
  So I can tell a bear's thread from any other at a glance

  # The demo runner has no bears yet, so these are checked by hand with
  # the bears experiment on (docs/guide.md, "Bears").
  @bears.tile @manual @gpui-pending
  Scenario: A bear's thread shows its icon on its colour
    Given a bear called "Writer" with the icon "pencil" and the colour "#3E8ED0"
    When a thread runs in Writer's folder
    Then its sidebar row shows a white pencil on blue where a folder would be
    And hovering the tile says "Writer"

  @bears.tile @manual @gpui-pending
  Scenario: The head bear shows a crown until it has an icon
    Given the head bear has no icon of its own
    Then its threads' tiles show a crown on its fur colour

  @bears.mention @manual @gpui-pending
  Scenario: Pick a bear from the @ list
    Given a bear called "Writer"
    When I type "Hey @wr" in the message box
    Then a list over the cursor offers "@Writer" with what it does
    When I press Tab
    Then the message reads "Hey @Writer "
    And the list closes

  @bears.colour @manual @gpui-pending
  Scenario: Pick a bear's colour from its thread's menu
    Given a thread in Writer's folder
    When I right-click its row and pick Bear Colour, then Moss
    Then the banner says Writer's colour is changing
    And every Writer thread's tile turns green
