\* Copyright 2020 MongoDB, Inc.
\*
\* This work is licensed under:
\* - Creative Commons Attribution-3.0 United States License
\*   http://creativecommons.org/licenses/by/3.0/us/

----------------------------- MODULE ContinuousDelivery -----------------------------
\*
\* A specification of MongoDB branches, versions, and features. Define our
\* continuous delivery methodology and policies, check that they satisfy
\* our goals.
\*

EXTENDS Integers, FiniteSets, Sequences, TLC

(**************************************************************************************************)
(* Constants                                                                                      *)
(**************************************************************************************************)

\* A reserved value.
CONSTANTS Nil

(**************************************************************************************************)
(* Global variables                                                                               *)
(**************************************************************************************************)

\* Commits are identified by numbers but they're ordered only within branches.
VARIABLE highestCommitNumber

\* Branches are sequences of [commitNumber |-> Int, fcvLow |-> Int, fcvHigh |-> Int]. fcvHigh/Low
\* are the arguments to setFeatureCompatibilityVersion that a server at this commit accepts.
\* TODO: fcvHigh is the one enabled by default? on upgrade of existing cluster fcvLow is enabled until setFCV()
\* Commits first appear on the master branch.
VARIABLE masterBranch

\* The continuous delivery branch.
VARIABLE cdBranch

\* The previous continuous delivery branch.
VARIABLE cdBranchPrevious

\* The long-term support branch.
VARIABLE ltsBranch

\* The previous long-term support branch.
VARIABLE ltsBranchPrevious

branches == <<masterBranch, cdBranch, cdBranchPrevious, ltsBranch, ltsBranchPrevious>>

\* Releases are like [versionNumber |-> Int, commit |-> COMMIT_RECORD].
\* The current continuous release version.
VARIABLE cdRelease

\* The previous continuous release version.
VARIABLE cdReleasePrevious

\* The current LTS release version.
VARIABLE ltsRelease

\* The previous LTS release version.
VARIABLE ltsReleasePrevious

releases == <<cdRelease, cdReleasePrevious, ltsRelease, ltsReleasePrevious>>

vars == <<highestCommitNumber, branches, releases>>

-------------------------------------------------------------------------------------------

(**************************************************************************************************)
(* Generic helper operators                                                                       *)
(**************************************************************************************************)

\* Return the minimum value from a set, or undefined if the set is empty.
Min(s) == CHOOSE x \in s : \A y \in s : x <= y

\* Return the maximum value from a set, or undefined if the set is empty.
Max(s) == CHOOSE x \in s : \A y \in s : x >= y

\* Return the range of a given function.
Range(f) == {f[x] : x \in DOMAIN f}

\* Is a sequence empty.
Empty(s) == Len(s) = 0

\* Last element of a sequence.
Last(s) == s[Len(s)]

-------------------------------------------------------------------------------------------

(******************************************************************************)
(* Next state actions.                                                        *)
(*                                                                            *)
(* This section defines the core steps of the algorithm, along with some      *)
(* related helper definitions/operators.  We annotate the main actions with   *)
(* an [ACTION] specifier to distinguish them from auxiliary, helper operators.*)
(******************************************************************************)

(******************************************************************************)
(* [ACTION]                                                                   *)
(*                                                                            *)
(* Commit a code change on master                                             *)
(******************************************************************************)

CommitOnMasterAction ==
    /\ highestCommitNumber' = highestCommitNumber + 1
    /\ LET nextCommit == [commitNumber |-> highestCommitNumber',
                          fcvLow |-> Last(masterBranch).fcvLow,
                          fcvHigh |-> Last(masterBranch).fcvHigh] IN
        /\ masterBranch' = Append(masterBranch, nextCommit)
    /\ UNCHANGED <<cdBranch, cdBranchPrevious, ltsBranch, ltsBranchPrevious, releases>>

(******************************************************************************)
(* [ACTION]                                                                   *)
(*                                                                            *)
(* Branch from master in preparation for a continuous delivery release        *)
(******************************************************************************)

CreateCDBranchAction ==
    /\ Last(cdBranch).commitNumber < Last(masterBranch).commitNumber
    \* CD branch is rooted at master's latest commit.
    /\ cdBranch' = <<Last(masterBranch)>>
    /\ cdBranchPrevious' = cdBranch
    /\ UNCHANGED <<highestCommitNumber, masterBranch, ltsBranch, ltsBranchPrevious, releases>>

(******************************************************************************)
(* [ACTION]                                                                   *)
(*                                                                            *)
(* Release a continuous delivery version                                      *)
(******************************************************************************)

ReleaseCDVersionAction ==
    /\ cdRelease.commit.commitNumber < Last(cdBranch).commitNumber
    /\ cdRelease' = [versionNumber |-> cdRelease.versionNumber + 1,
                     commit |-> Last(cdBranch)]
    /\ cdReleasePrevious' = cdRelease
    /\ UNCHANGED <<highestCommitNumber, branches, ltsRelease, ltsReleasePrevious>>

(******************************************************************************)
(* [ACTION]                                                                   *)
(*                                                                            *)
(* Make an LTS version from the previous continuous delivery version          *)
(******************************************************************************)

ReleaseLTSVersionAction ==
    /\ ltsRelease.commit.commitNumber < Last(cdBranchPrevious).commitNumber
    /\ ltsRelease' = [versionNumber |-> cdReleasePrevious.versionNumber,
                     commit |-> Last(cdBranchPrevious)]
    /\ ltsReleasePrevious' = ltsRelease
    /\ UNCHANGED <<highestCommitNumber, branches, cdRelease, cdReleasePrevious>>

-------------------------------------------------------------------------------------------

(**************************************************************************************************)
(* Miscellaneous properties for exploring/understanding the spec.                                 *)
(**************************************************************************************************)

ENABLEDCreateCDBranchAction == ENABLED CreateCDBranchAction

(**************************************************************************************************)
(* Correctness Properties                                                                         *)
(**************************************************************************************************)

LTSFCV ==
    /\ ltsRelease.commit.fcvLow = ltsReleasePrevious.commit.fcvHigh
    /\ ltsRelease.commit.fcvHigh = ltsReleasePrevious.commit.fcvHigh + 1

CDNewerThanLTS ==
    /\ cdRelease.versionNumber > ltsRelease.versionNumber

\* TODO: no, there's a point some time after LTS this increments, but not on first CD release
CDFCV ==
    /\ cdRelease.commit.fcvLow = ltsRelease.commit.fcvHigh
    /\ cdRelease.commit.fcvHigh = ltsRelease.commit.fcvHigh + 1


\* TODO: INVARIANTS FOR THESE ASSERTIONS:
\*In CD N+1, no features are expected to be conditionally enabled using FCV, since LTS V (CD N) supports all such features that are enabled in CD N+1. CD N+2, CD N+3, and LTS V+1 (CD N+4) are expected to gate features using FCV.
\*
\*In CD N+1, downgrading FCV from V+1 to V is expected to always succeed and cause no on-disk transformations, since LTS V (CD N) supports all features that are enabled in CD N+1. Downgrading FCV from V to V-1 in LTS V (CD N) must remove any on-disk format changes for features enabled in CD N+1.



(**************************************************************************************************)
(* Liveness properties                                                                            *)
(**************************************************************************************************)

\* TODO: delete this section?

(**************************************************************************************************)
(* Spec definition                                                                                *)
(**************************************************************************************************)
Init ==
    /\ highestCommitNumber = 3
    /\ LET commit1 == [commitNumber |-> 1, fcvLow |-> 1, fcvHigh |-> 2]
           commit2 == [commitNumber |-> 2, fcvLow |-> 2, fcvHigh |-> 3]
           commit3 == [commitNumber |-> 3, fcvLow |-> 3, fcvHigh |-> 4] IN
        \* -- Branches --
        /\ masterBranch = <<commit3>>
        /\ cdBranch = <<commit3>>
        /\ cdBranchPrevious = <<commit2>>
        /\ ltsBranch = <<commit2>>
        /\ ltsBranchPrevious = <<commit1>>
        \* -- Releases --
        /\ cdRelease = [versionNumber |-> 4, commit |-> commit3]
        /\ cdReleasePrevious = [versionNumber |-> 3, commit |-> commit2]
        /\ ltsRelease = cdReleasePrevious
        /\ ltsReleasePrevious = [versionNumber |-> 2, commit |-> commit1]

Next ==
    \/ CommitOnMasterAction
    \/ CreateCDBranchAction
    \/ ReleaseCDVersionAction
    \/ ReleaseLTSVersionAction

Spec == Init /\ [][Next]_vars

=============================================================================
