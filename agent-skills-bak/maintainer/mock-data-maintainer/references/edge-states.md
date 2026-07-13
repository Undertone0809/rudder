# Edge States

Use these states to make mock data useful for testing and UI review.

## Universal UI States

- empty list
- first item just created
- dense list
- search returns no result
- filter hides all visible items
- loading with stale previous data
- partial failure
- permission denied
- validation error
- optimistic update rollback

## Workflow States

- draft
- pending review
- approved
- rejected
- blocked
- in progress
- succeeded
- failed
- canceled
- timed out
- archived

## Data Boundary States

- zero amount
- near budget limit
- over budget
- missing optional field
- very long title
- duplicate name
- unicode text when supported
- old timestamp
- future scheduled timestamp
- cross-organization access attempt

## Rudder-Specific Edge States

- agent paused by budget hard stop
- agent idle with no heartbeat
- heartbeat run still running
- heartbeat run failed with visible summary
- approval pending on public-facing change
- chat proposal created but not approved
- issue checked out by one agent while another agent receives conflict
- cost event linked to an issue and project
- activity log entry for each mutating action
