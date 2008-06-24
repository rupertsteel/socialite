// A failure callback to retry an action a set number of times

Components.utils.import("resource://socialite/debug.jsm");
Components.utils.import("resource://socialite/utils/action.jsm");

var nsITimer = Components.classes["@mozilla.org/timer;1"]
             .createInstance(Components.interfaces.nsITimer);

var EXPORTED_SYMBOLS = ["retryAction"]

function retryAction(startCount, delay, retryCallback, successCallback, failureCallback) {
  var act = new _RetryAction(successCallback, failureCallback);
  act.count = startCount;
  act.delay = delay
  act.retryCallback = retryCallback;
  
  return act;
}

var _RetryAction = Action("retry", function() {
  var argsLen = arguments.length;
  
  // Get the last argument
  var action = arguments[argsLen-1];

  if (!this.count) {
    this.failure.apply(this, arguments);
  } else {
    var self = this;
    debug_log(self.actionName, action.actionName + " has failed, retrying (" + self.count + " retrys left)");
    
    var doRetry = function() {
      // Call the retry callback
      self.doCallback(self.retryCallback, null, arguments);
         
      self.count -= 1;
        
      // Perform the action again.
      action.perform.apply(action, arguments);
    }
    
    if (this.delay) {
      debug_log(self.actionName, "Waiting " + self.delay + " milliseconds");
      nsITimer.initWithCallback(doRetry, this.delay,  nsITimer.TYPE_ONE_SHOT);
    } else {
      doRetry();
    }
  }
});