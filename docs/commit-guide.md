Commit Format

type(scope): short summary

Example:

feat(booking): add reschedule flow
fix(logging): prevent duplicate chat logs
refactor(ai): simplify prompt generation
docs: update release notes
chore: upgrade dependencies




⸻

Allowed Commit Types

Type	Purpose	Version                        Impact
feat	new feature	                           minor
fix	bug fix	                                   patch
perf	performance improvement	               patch
refactor	code restructuring	               none
docs	documentation	                       none
test	test improvements	                   none
chore	maintenance	                           none
build	build changes	                       none


⸻

Example Commits for Donna

Feature

feat(booking): add booking confirmation message

Bug Fix

fix(ai): prevent double booking suggestion

Refactor

refactor(webhook): extract message processor

Performance

perf(calendar): cache availability lookup


⸻

Breaking Change

Breaking changes require:

feat!: redesign booking API

or

BREAKING CHANGE: instructor config schema updated

This triggers major version bump.