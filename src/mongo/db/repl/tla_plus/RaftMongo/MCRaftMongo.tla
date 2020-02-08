---- MODULE MCRaftMongo ----
\* This module defines RaftMongo.tla constants/constraints for model-checking.
\* See RaftMongo.tla for instructions.

EXTENDS RaftMongo

CONSTANT MaxTerm
CONSTANT MaxLogLen

StateConstraint ==
    /\ globalCurrentTerm <= MaxTerm
    /\ \forall i \in Server: Len(log[i]) <= MaxLogLen
=============================================================================
