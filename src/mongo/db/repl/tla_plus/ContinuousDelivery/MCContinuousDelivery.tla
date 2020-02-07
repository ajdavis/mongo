---- MODULE MCContinuousDelivery ----
\* This module defines MCContinuousDelivery.tla constants/constraints for model-checking.

EXTENDS ContinuousDelivery

(**************************************************************************************************)
(* State Constraint. Used for model checking only.                                                *)
(**************************************************************************************************)

\* CONSTANTS MaxTerm, MaxLogLen, MaxConfigVersion
\*
\* StateConstraint == \A s \in Server :
\*                     /\ currentTerm[s] <= MaxTerm
\*                     /\ Len(log[s]) <= MaxLogLen
\*                     /\ configVersion[s] <= MaxConfigVersion
\*
\* ServerSymmetry == Permutations(Server)
=============================================================================
