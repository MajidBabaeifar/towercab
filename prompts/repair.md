{{what}}

{{details}}

Fix it in this same session, keeping to the plan. Tests you already pushed are locked in a repair
round: change the code, not the tests (new tests are fine). Run the checks again until they pass, then
return the same JSON result as before, with an updated `pr` description if the change grew.
